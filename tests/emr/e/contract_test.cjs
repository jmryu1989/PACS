/* EMR-E R1 contract cases (pure; no stack, network, database or browser).
 *
 * REQ-EMR-07/11 -> RISK-E-01 -> TEST-E-01 delivery_states   REQ-EMR-11/17 -> RISK-E-02 -> TEST-E-02 manifest_sources
 * REQ-EMR-07/19 -> RISK-E-03 -> TEST-E-03 basis_and_bypass  REQ-EMR-11/17 -> RISK-E-04 -> TEST-E-04 offline_ready
 * REQ-EMR-07/16 -> RISK-E-05 -> TEST-E-05 display_epoch
 *
 * The modules api/src/emr-image/{manifest,contract}.ts are compiled with the installed TypeScript and api/tsconfig, as
 * tests/emr_contract_test.cjs does. Every case is an allowed/refused behaviour pair on returned facts and error codes;
 * nothing here reads implementation text. Refusals are checked together with "no body source was called" and with the
 * inputs left unchanged. Synthetic UIDs, hashes and identities only.
 *
 * KIN_EMR_E_SOURCE_DIR (tests/emr/e/mutants.py only) points the loader at a mutated copy of api/src outside the tree.
 * `node tests/emr/e/contract_test.cjs --list-cases` prints the declared case list instead of running it.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const CASES = [
  'TEST-E-01 delivery_states A1 whole object written after the durable receipt and ended is complete; each stage keeps its own access action',
  'TEST-E-01 delivery_states A2 multipart frames and a resumed range pair over one manifest version are complete',
  'TEST-E-01 delivery_states A3 a generated metadata body is complete only inside the one ended response that wrote all of it',
  'TEST-E-01 delivery_states R1 the authz 204 alone delivers nothing',
  'TEST-E-01 delivery_states R2 an aborted response never completes a unit even when every byte was written',
  'TEST-E-01 delivery_states R3 a missing last frame or an unknown ending is not complete',
  'TEST-E-01 delivery_states R4 bytes before the durable receipt, a foreign receipt or a body on HEAD are refused',
  'TEST-E-01 delivery_states R5 bytes whose source hash differs from the fixed manifest are a mismatch, unhashed bytes stay unverified',
  'TEST-E-01 delivery_states R6 an unknown append is re-read by its event ID and only a found receipt allows the body',
  'TEST-E-01 delivery_states R7 a range without its own hash verification leaves the unit unverified even beside a verified range',
  'TEST-E-01 delivery_states R8 ranges sent to another account generation, opening, institution or relation never complete one provision',
  'TEST-E-02 manifest_sources A1 every held object keeps SOP, frames, bytes, hash, origin, source and MG/DBT/XA facts under one content digest',
  'TEST-E-02 manifest_sources A2 identical relisting collapses and an unknown format stays listed but undeliverable while the study opens',
  'TEST-E-02 manifest_sources A3 XA frame order and the stored timing are kept as stored and only reported as verified or not',
  'TEST-E-02 manifest_sources A4 a one-frame Breast Tomosynthesis object typed GENERATED_2D in Image and Frame Type is the device synthetic 2D; DBT slices or slabs follow Volumetric Properties',
  'TEST-E-02 manifest_sources R1 the same SOP with different bytes is refused',
  'TEST-E-02 manifest_sources R2 a missing last frame or a repeated frame number is refused',
  'TEST-E-02 manifest_sources R3 an incomplete or broken page chain is refused',
  'TEST-E-02 manifest_sources R4 an external object without its source, or a source claim that hides the producer, is refused',
  'TEST-E-02 manifest_sources R5 a multi-frame or mistyped tomosynthesis object is never a generated 2D and DERIVED alone is not synthetic evidence',
  'TEST-E-02 manifest_sources R6 relabelled origin, a foreign study object, a missing decoder pin or a copied manifest is refused',
  'TEST-E-03 basis_and_bypass A1 reading inside the managing institution needs no consent, contract or extra step and delivers',
  'TEST-E-03 basis_and_bypass A2 a complete processor agreement delivers; a lawful third-party basis is recorded but sends no body in Part 1',
  'TEST-E-03 basis_and_bypass A3 the image grammar parses exactly the DICOMweb shapes the viewer and worklist use',
  'TEST-E-03 basis_and_bypass R1 a revoked, expired, early, out-of-scope or missing recipient basis is refused before any body',
  'TEST-E-03 basis_and_bypass R2 an incomplete, inactive, undisclosed, sub-processed or overseas processor agreement is refused',
  'TEST-E-03 basis_and_bypass R3 direct Orthanc paths and escaped paths are refused before any read',
  'TEST-E-03 basis_and_bypass R4 a scope outside the manifest, a foreign 204 or a forged request or decision prepares nothing',
  'TEST-E-03 basis_and_bypass R5 the body-start spy still sees a body that started before a refusal',
  'TEST-E-04 offline_ready A1 a fully verified current and selected comparison bundle is ready and stays ready after a restart',
  'TEST-E-04 offline_ready A2 grant expiry or end stops offline viewing and keeps the queue',
  'TEST-E-04 offline_ready A3 an offline view keeps device time, device and order with no observed address; reconnection is its own event',
  'TEST-E-04 offline_ready R1 thumbnails only or one frame short is not ready',
  'TEST-E-04 offline_ready R2 a missing comparison, short storage or journal, or a stale plan is reported by name',
  'TEST-E-04 offline_ready R3 a missing decoder or viewer asset is not ready',
  'TEST-E-04 offline_ready R4 another patient, an unselected study, an inconsistent requirement or a broken offline order is refused',
  'TEST-E-04 offline_ready R5 an object left out of the device copy keeps the bundle not ready by name while the study still opens online',
  'TEST-E-05 display_epoch A1 the current opening records network, cache and offline-store displays separately from delivery',
  'TEST-E-05 display_epoch A2 an explicit ACK binds to a display of the current opening and is its own record',
  'TEST-E-05 display_epoch R1 background loads, earlier openings (A to B to A), another account generation or version, or another opening\'s delivery are not displays',
  'TEST-E-05 display_epoch R2 an ACK from an earlier generation or without a display is refused',
  'TEST-E-05 display_epoch R3 a HEAD response or a header bulk attribute is not evidence that pixels were shown; the Pixel Data bulk is',
];
if (process.argv.includes('--list-cases')) {
  process.stdout.write(JSON.stringify(CASES) + '\n');
  process.exit(0);
}

const assert = require('node:assert/strict');
const { test } = require('node:test');
const root = path.resolve(__dirname, '../../..');
// KIN_EMR_E_API_DIR: mutants.py runs a mutated copy of this file from outside the tree and points it back at api/.
const api = process.env.KIN_EMR_E_API_DIR ? path.resolve(process.env.KIN_EMR_E_API_DIR) : path.join(root, 'api');
const source = process.env.KIN_EMR_E_SOURCE_DIR ? path.resolve(process.env.KIN_EMR_E_SOURCE_DIR) : path.join(api, 'src');
const ts = require(path.join(api, 'node_modules/typescript'));
const originalTsLoader = require.extensions['.ts'];
const config = ts.readConfigFile(path.join(api, 'tsconfig.json'), ts.sys.readFile);
assert.equal(config.error, undefined);
const parsedConfig = ts.parseJsonConfigFileContent(config.config, ts.sys, api);
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'),
  { compilerOptions: parsedConfig.options, fileName: filename }).outputText, filename);
const M = require(path.join(source, 'emr-image/manifest.ts'));
const E = require(path.join(source, 'emr-image/contract.ts'));
if (originalTsLoader) require.extensions['.ts'] = originalTsLoader; else delete require.extensions['.ts'];

const registered = new Set();
/** id: "TEST-E-0n suffix An|Rn"; it names exactly one declared case. */
function def(id, fn) {
  const matches = CASES.filter(name => name.startsWith(id + ' '));
  assert.equal(matches.length, 1, `case id must name one declared case: ${id}`);
  const name = matches[0];
  assert.ok(!registered.has(name), `duplicate case: ${name}`);
  registered.add(name);
  test(name, fn);
}
function refused(fn, code) {
  let error = null;
  try { fn(); } catch (e) { error = e; }
  assert.ok(error, `expected refusal ${code}, got a result`);
  assert.equal(error.code, code, `expected refusal ${code}, got ${error.code ?? error.message}`);
}
/** The allowed side of a pair: a refusal here is the behaviour failing, reported as an assertion with its code. */
function allowed(fn) {
  try { return fn(); } catch (e) { assert.fail(`expected the allowed path, got refusal ${e.code ?? e.message}`); }
}
async function refusedAsync(fn, code) {
  let error = null;
  try { await fn(); } catch (e) { error = e; }
  assert.ok(error, `expected refusal ${code}, got a result`);
  assert.equal(error.code, code);
}

// ── synthetic study ─────────────────────────────────────────────────────────────────────────────────────────────
const h = label => createHash('sha256').update(String(label)).digest('hex');
const SC = suffix => '1.2.840.10008.5.1.4.1.1.' + suffix;
const TS = { explicit: '1.2.840.10008.1.2.1', j2k: '1.2.840.10008.1.2.4.90', jpeg: '1.2.840.10008.1.2.4.50', unknown: '1.2.3.4.5.6.7' };
const STUDY = '2.25.100', PRIOR = '2.25.200', OTHER = '2.25.300';
const PATIENT = { linkId: 'link-syn-1', patientId: 'SYN-1', assigningAuthority: 'hospital-a' };
const INSTITUTION = 'hospital-a';
const T0 = '2026-10-09T01:00:00.000Z', T1 = '2026-10-09T02:00:00.000Z', T2 = '2026-10-09T03:00:00.000Z';
const frameSet = (sop, n, size = 1000) => Array.from({ length: n }, (_, i) => ({ number: i + 1, bytes: size, sha256: h(`${sop}#${i + 1}`) }));
function pixel(study, series, sop, sopClass, opts = {}) {
  const n = opts.frames ?? 1;
  return { studyUid: study, seriesUid: series, sopInstanceUid: sop, sopClassUid: sopClass, transferSyntaxUid: opts.ts ?? TS.explicit,
    imageType: opts.imageType ?? ['ORIGINAL', 'PRIMARY'], bytes: n * (opts.frameBytes ?? 1000) + 4000, sha256: opts.sha256 ?? h(sop),
    declaredFrameCount: opts.declared ?? n, frames: opts.frameList ?? frameSet(sop, n, opts.frameBytes ?? 1000),
    provenance: opts.provenance ?? { kind: 'device', receiptEventId: `rcpt-${sop}` },
    derivation: opts.derivation ?? { kind: 'original' }, mammography: opts.mammography ?? null, timing: opts.timing ?? null };
}
function doc(study, series, sop, sopClass, provenance) {
  return { studyUid: study, seriesUid: series, sopInstanceUid: sop, sopClassUid: sopClass, transferSyntaxUid: TS.explicit, imageType: null,
    bytes: 2048, sha256: h(sop), declaredFrameCount: 0, frames: [], provenance, derivation: { kind: 'not-image' }, mammography: null, timing: null };
}
const external = (system = 'Vendor AI', evidence = { status: 'present', sha256: h('sig') }) => ({ kind: 'external', system, receiptEventId: 'import-7', signatureEvidence: evidence });
const S = (study, n) => `${study}.${n}`;
const DBT = S(STUDY, 3) + '.1', SYNTH = S(STUDY, 4) + '.1';
/** The E-MG verdict plus the stored Frame Type list and Volumetric Properties it was read from. */
const role = (kind, laterality, frameTypes = null, volumetricProperties = null, view = 'CC') => ({ kind, laterality, view, frameTypes, volumetricProperties });
/** Header shape of a Hologic Selenia Dimensions "Intelligent 2D" (EA1141-4339969, read by E-MG): one frame of the Breast
 * Tomosynthesis IOD whose Image Type and Frame Type are DERIVED\PRIMARY\TOMOSYNTHESIS\GENERATED_2D, VOLUME / MAX_IP. */
const I2D_TYPE = ['DERIVED', 'PRIMARY', 'TOMOSYNTHESIS', 'GENERATED_2D'];
const hologicSynthetic = (study, series, sop, laterality = 'L', sources = []) => pixel(study, series, sop, SC('13.1.3'), { ts: TS.j2k,
  imageType: I2D_TYPE, derivation: { kind: 'derived', sources }, mammography: role('generated-2d', laterality, [I2D_TYPE], 'VOLUME') });
/** Its paired 1 mm DBT: DERIVED\PRIMARY\TOMOSYNTHESIS\NONE, many frames, VOLUME (slices). */
const DBT_TYPE = ['DERIVED', 'PRIMARY', 'TOMOSYNTHESIS', 'NONE'];
const hologicDbt = (study, series, sop, frames = 60, laterality = 'L', volumetric = 'VOLUME') => pixel(study, series, sop, SC('13.1.3'), { ts: TS.j2k,
  frames, frameBytes: 10, imageType: DBT_TYPE, derivation: { kind: 'derived', sources: [] }, mammography: role('dbt', laterality, [DBT_TYPE], volumetric) });
function studyObjects(study = STUDY) {
  return [
    pixel(study, S(study, 1), S(study, 1) + '.1', SC('2'), { imageType: ['ORIGINAL', 'PRIMARY', 'AXIAL'] }),
    pixel(study, S(study, 1), S(study, 1) + '.2', SC('2'), { imageType: ['ORIGINAL', 'PRIMARY', 'AXIAL'] }),
    pixel(study, S(study, 2), S(study, 2) + '.1', SC('1.2'), { imageType: ['DERIVED', 'PRIMARY'], derivation: { kind: 'derived', sources: [] },
      mammography: role('conventional-2d', 'R') }),
    pixel(study, S(study, 3), S(study, 3) + '.1', SC('13.1.3'), { ts: TS.j2k, frames: 6, imageType: ['ORIGINAL', 'PRIMARY', 'TOMOSYNTHESIS', 'NONE'],
      mammography: role('dbt', 'L', [['ORIGINAL', 'PRIMARY', 'TOMOSYNTHESIS', 'NONE']], 'VOLUME') }),
    pixel(study, S(study, 4), S(study, 4) + '.1', SC('1.2'), { imageType: ['DERIVED', 'PRIMARY', 'TOMOSYNTHESIS', 'GENERATED_2D'],
      derivation: { kind: 'derived', sources: [{ studyUid: study, seriesUid: S(study, 3), sopInstanceUid: S(study, 3) + '.1' }] },
      mammography: role('generated-2d', 'L') }),
    pixel(study, S(study, 5), S(study, 5) + '.1', SC('12.1'), { ts: TS.jpeg, frames: 8, imageType: ['ORIGINAL', 'PRIMARY', 'SINGLE PLANE'],
      timing: { source: 'frame-time-vector', vectorMs: [0, 66, 67, 66, 67, 66, 67, 66] } }),
    doc(study, S(study, 6), S(study, 6) + '.1', SC('88.22'), external()),
    doc(study, S(study, 6), S(study, 6) + '.2', SC('88.33'), { kind: 'product-authored', recordId: 'manual-sr-1' }),
    doc(study, S(study, 7), S(study, 7) + '.1', SC('104.1'), external('Referring EMR', { status: 'absent' })),
  ];
}
const CATALOG = Object.fromEntries(['native', 'jpeg-baseline', 'jpeg-2000', 'jpeg-lossless', 'jpeg-ls', 'htj2k', 'rle', 'deflate']
  .map(id => [id, { version: `${id}-1.0.0`, sha256: h(`decoder:${id}`) }]));
const VIEWER = { id: 'ohif-kin', version: '3.9.2-kin.7', sha256: h('viewer') };
function manifestInput(objects = studyObjects(), opts = {}) {
  const study = opts.study ?? objects[0].studyUid, split = opts.split ?? Math.ceil(objects.length / 2);
  const pages = opts.pages ?? [{ cursor: null, next: 'page-2', objects: objects.slice(0, split) }, { cursor: 'page-2', next: null, objects: objects.slice(split) }];
  const unique = new Map(objects.map(o => [o.sopInstanceUid, o]));
  return { formatVersion: 1, studyUid: study, managingInstitution: opts.institution ?? INSTITUTION, patient: opts.patient ?? PATIENT, builtAt: T0,
    expected: opts.expected ?? { series: new Set([...unique.values()].map(o => o.seriesUid)).size, objects: unique.size },
    pages, decoderCatalog: opts.catalog ?? CATALOG, viewer: opts.viewer ?? VIEWER };
}
const build = (...args) => M.buildImageManifest(manifestInput(...args));
const sameInstitution = (study = STUDY, at = T1) => E.checkProvisionBasis({ relation: 'same-institution', at, managingInstitution: INSTITUTION, recipient: null,
  studyUid: study, purpose: null, basis: null, agreement: null, auditBefore: null });
let eventCounter = 0;
const GENERATION = 4;
function prepare(manifest, target, opts = {}) {
  const accountGeneration = opts.accountGeneration ?? opts.opening?.accountGeneration ?? GENERATION;
  return E.prepareDelivery(manifest, E.parseImageRequest(opts.method ?? 'GET', target), { eventId: opts.eventId ?? `evt-${++eventCounter}`,
    cause: opts.cause ?? 'user-view', at: T1,
    authorization: opts.authorization ?? { studyUid: manifest.studyUid, institution: manifest.managingInstitution, accountGeneration },
    provision: opts.provision ?? sameInstitution(manifest.studyUid), opening: opts.opening ?? null });
}
const receipt = p => ({ stage: 'provide-prepared', receipt: { eventId: p.eventId, durableAt: T1 } });
/** The stream read the whole unit from the store as readId and hashed it; the written range came from that read. */
const verified = (unit, sha = unit.sha256, readId = 'read-1') => ({ source: 'store-read', readId, sha256: sha });
const wrote = (unit, start, end, verifiedBy = unit.sha256 ? verified(unit) : null) => ({ stage: 'bytes', unit: unit.key, start, end, verifiedBy });
const ended = { stage: 'transfer-ended' }, aborted = { stage: 'transfer-aborted' }, unknown = { stage: 'transfer-unknown' };
const full = p => [{ stage: 'authorized', status: 204 }, receipt(p), ...p.units.map(u => wrote(u, 0, u.expectedBytes)), ended];
/** What R2's stream does around its first byte. The spy lives outside the call, so a body that started before a
 * refusal is still seen after the refusal propagates. */
function serve(spy, manifest, method, target, provisionInput) {
  const request = E.parseImageRequest(method, target);
  const provision = provisionInput === undefined ? sameInstitution(manifest.studyUid) : E.checkProvisionBasis(provisionInput);
  const actor = provision.relation === 'processor' ? provision.recipient : manifest.managingInstitution;
  const p = E.prepareDelivery(manifest, request, { eventId: `evt-${++eventCounter}`, cause: 'user-view', at: T1,
    authorization: { studyUid: manifest.studyUid, institution: actor, accountGeneration: GENERATION }, provision, opening: null });
  spy.body++;
  spy.prepared.push(p);
  return p;
}
/** R1 claim, exactly: on a refusal no delivery plan is issued and the body hook never ran, before or after the throw. */
function bodyNeverStarts(fn, code) {
  const spy = { body: 0, prepared: [] };
  refused(() => fn(spy), code);
  assert.equal(spy.body, 0, 'no body source may start on a refused provision');
  assert.equal(spy.prepared.length, 0, 'no delivery plan may be issued on a refused provision');
}

// ── TEST-E-01 delivery_states ───────────────────────────────────────────────────────────────────────────────────
def('TEST-E-01 delivery_states A1', () => {
  const m = build(), sop = S(STUDY, 1) + '.1', p = prepare(m, `/dicom-web/studies/${STUDY}/series/${S(STUDY, 1)}/instances/${sop}`);
  assert.deepEqual(p.units.map(u => [u.part, u.expectedBytes, u.sha256, u.recordKind]), [['object', 5000, h(sop), 'image']]);
  const judged = E.judgeDelivery([{ prepared: p, observations: full(p) }]);
  assert.equal(judged.outcome, 'complete');
  assert.deepEqual(judged.units.map(u => [u.status, u.confirmed]), [['complete', [[0, 5000]]]]);
  assert.deepEqual(judged.responses, [{ eventId: p.eventId, prepared: true, terminal: 'transfer-ended' }]);
  // Authorization, preparation, the transfer outcome and the unknown outcome are four different records.
  assert.deepEqual({ ...E.DELIVERY_STAGE_ACCESS_ACTION }, { 'provide-prepared': 'provide-prepared', 'transfer-ended': 'transfer-ended',
    'transfer-aborted': 'transfer-aborted', 'transfer-unknown': null });
});
def('TEST-E-01 delivery_states A2', () => {
  const m = build(), dbt = S(STUDY, 3) + '.1';
  const p = prepare(m, `/dicom-web/studies/${STUDY}/series/${S(STUDY, 3)}/instances/${dbt}/frames/1,2,3,4,5,6`);
  assert.deepEqual(p.units.map(u => u.frame), [1, 2, 3, 4, 5, 6]);
  assert.equal(E.judgeDelivery([{ prepared: p, observations: full(p) }]).outcome, 'complete');
  // Resume: the first response wrote a prefix and ended; the second wrote the rest and ended. Same manifest version.
  const ct = S(STUDY, 1) + '.2', target = `/dicom-web/studies/${STUDY}/series/${S(STUDY, 1)}/instances/${ct}`;
  const a = prepare(m, target), b = prepare(m, target), u = a.units[0];
  const judged = E.judgeDelivery([{ prepared: a, observations: [receipt(a), wrote(u, 0, 3000), ended] },
    { prepared: b, observations: [receipt(b), wrote(b.units[0], 3000, 5000), ended] }]);
  assert.equal(judged.outcome, 'complete');
  assert.deepEqual(judged.units[0].confirmed, [[0, 5000]]);
  // The prefix alone is partial, not complete.
  assert.equal(E.judgeDelivery([{ prepared: a, observations: [receipt(a), wrote(u, 0, 3000), ended] }]).units[0].status, 'partial');
});
def('TEST-E-01 delivery_states A3', () => {
  const m = build(), p = prepare(m, `/dicom-web/studies/${STUDY}/series/${S(STUDY, 1)}/metadata`), u = p.units[0];
  assert.deepEqual([u.part, u.expectedBytes, u.recordKind], ['derived', null, 'study-metadata']);
  const one = [receipt(p), { stage: 'unit-length', unit: u.key, length: 900 }, wrote(u, 0, 900, null), ended];
  assert.equal(E.judgeDelivery([{ prepared: p, observations: one }]).outcome, 'complete');
  // Two responses of a generated body are never stitched together.
  const q = prepare(m, `/dicom-web/studies/${STUDY}/series/${S(STUDY, 1)}/metadata`);
  const split = E.judgeDelivery([
    { prepared: p, observations: [receipt(p), { stage: 'unit-length', unit: u.key, length: 900 }, wrote(u, 0, 400, null), ended] },
    { prepared: q, observations: [receipt(q), { stage: 'unit-length', unit: q.units[0].key, length: 900 }, wrote(q.units[0], 400, 900, null), ended] }]);
  assert.equal(split.outcome, 'incomplete');
  refused(() => E.judgeDelivery([{ prepared: p, observations: [receipt(p), wrote(u, 0, 10, null), ended] }]), 'RangeOutsideUnit');
});
def('TEST-E-01 delivery_states R1', () => {
  const m = build(), p = prepare(m, `/dicom-web/studies/${STUDY}/series/${S(STUDY, 1)}/instances/${S(STUDY, 1)}.1`);
  const judged = E.judgeDelivery([{ prepared: p, observations: [{ stage: 'authorized', status: 204 }] }]);
  assert.equal(judged.outcome, 'unknown');
  assert.deepEqual(judged.units.map(u => u.status), ['not-sent']);
  assert.deepEqual(judged.responses, [{ eventId: p.eventId, prepared: false, terminal: null }]);
  const withEnd = E.judgeDelivery([{ prepared: p, observations: [{ stage: 'authorized', status: 204 }, aborted] }]);
  assert.notEqual(withEnd.outcome, 'complete');
  assert.deepEqual(withEnd.units.map(u => u.status), ['not-sent']);
});
def('TEST-E-01 delivery_states R2', () => {
  const m = build(), p = prepare(m, `/dicom-web/studies/${STUDY}/series/${S(STUDY, 1)}/instances/${S(STUDY, 1)}.1`), u = p.units[0];
  const judged = E.judgeDelivery([{ prepared: p, observations: [receipt(p), wrote(u, 0, u.expectedBytes), aborted] }]);
  assert.equal(judged.outcome, 'incomplete');
  assert.deepEqual(judged.units.map(x => [x.status, x.confirmed]), [['unconfirmed', []]]);
  assert.deepEqual(judged.responses[0].terminal, 'transfer-aborted');
  // An aborted prefix plus an ended remainder still leaves the prefix unconfirmed.
  const q = prepare(m, `/dicom-web/studies/${STUDY}/series/${S(STUDY, 1)}/instances/${S(STUDY, 1)}.1`);
  const resumed = E.judgeDelivery([{ prepared: p, observations: [receipt(p), wrote(u, 0, 3000), aborted] },
    { prepared: q, observations: [receipt(q), wrote(q.units[0], 3000, 5000), ended] }]);
  assert.equal(resumed.outcome, 'incomplete');
  assert.equal(resumed.units[0].status, 'unconfirmed');
});
def('TEST-E-01 delivery_states R3', () => {
  const m = build(), xa = S(STUDY, 5) + '.1';
  const p = prepare(m, `/dicom-web/studies/${STUDY}/series/${S(STUDY, 5)}/instances/${xa}/frames/1,2,3,4,5,6,7,8`);
  const last = p.units[p.units.length - 1];
  const judged = E.judgeDelivery([{ prepared: p, observations: [receipt(p), ...p.units.slice(0, -1).map(u => wrote(u, 0, u.expectedBytes)), ended] }]);
  assert.equal(judged.outcome, 'incomplete');
  assert.equal(judged.units.find(u => u.key === last.key).status, 'not-sent');
  const lost = E.judgeDelivery([{ prepared: p, observations: [receipt(p), ...p.units.map(u => wrote(u, 0, u.expectedBytes)), unknown] }]);
  assert.equal(lost.outcome, 'unknown');
  assert.ok(lost.units.every(u => u.status === 'unconfirmed'));
  const silent = E.judgeDelivery([{ prepared: p, observations: [receipt(p), ...p.units.map(u => wrote(u, 0, u.expectedBytes))] }]);
  assert.equal(silent.outcome, 'unknown');
});
def('TEST-E-01 delivery_states R4', () => {
  const m = build(), target = `/dicom-web/studies/${STUDY}/series/${S(STUDY, 1)}/instances/${S(STUDY, 1)}.1`;
  const p = prepare(m, target), u = p.units[0];
  refused(() => E.judgeDelivery([{ prepared: p, observations: [wrote(u, 0, 5000), receipt(p), ended] }]), 'BodyBeforeDurableReceipt');
  refused(() => E.judgeDelivery([{ prepared: p, observations: [{ stage: 'provide-prepared', receipt: { eventId: 'evt-other', durableAt: T1 } }] }]), 'DurabilityReceiptMismatch');
  refused(() => E.judgeDelivery([{ prepared: p, observations: [ended] }]), 'BodyBeforeDurableReceipt');
  refused(() => E.judgeDelivery([{ prepared: p, observations: [receipt(p), ended, wrote(u, 0, 5000)] }]), 'ObservationOrderInvalid');
  const head = prepare(m, target, { method: 'HEAD' });
  assert.equal(head.body, false);
  refused(() => E.judgeDelivery([{ prepared: head, observations: [receipt(head), wrote(head.units[0], 0, 5000), ended] }]), 'BodyOnHeadRequest');
  assert.equal(E.judgeDelivery([{ prepared: head, observations: [receipt(head), ended] }]).outcome, 'no-body');
  refused(() => E.judgeDelivery([{ prepared: structuredClone(p), observations: full(p) }]), 'PreparedDeliveryRequired');
});
def('TEST-E-01 delivery_states R5', () => {
  const m = build(), p = prepare(m, `/dicom-web/studies/${STUDY}/series/${S(STUDY, 1)}/instances/${S(STUDY, 1)}.1`), u = p.units[0];
  const swapped = E.judgeDelivery([{ prepared: p, observations: [receipt(p), wrote(u, 0, 5000, verified(u, h('other bytes'))), ended] }]);
  assert.equal(swapped.outcome, 'mismatch');
  assert.equal(swapped.units[0].status, 'mismatch');
  const unhashed = E.judgeDelivery([{ prepared: p, observations: [receipt(p), wrote(u, 0, 5000, null), ended] }]);
  assert.equal(unhashed.outcome, 'incomplete');
  assert.equal(unhashed.units[0].status, 'unverified');
  // A version change between two ranges is never stitched: the second range belongs to another manifest.
  const changed = studyObjects(); changed[0] = { ...changed[0], bytes: 5000, sha256: h('re-sent object') };
  const later = prepare(build(changed), `/dicom-web/studies/${STUDY}/series/${S(STUDY, 1)}/instances/${S(STUDY, 1)}.1`);
  refused(() => E.judgeDelivery([{ prepared: p, observations: [receipt(p), wrote(u, 0, 3000), ended] },
    { prepared: later, observations: [receipt(later), wrote(later.units[0], 3000, 5000), ended] }]), 'ManifestVersionMismatch');
});
def('TEST-E-01 delivery_states R6', async () => {
  let sent = 0;
  const sendIf = result => { if (result.status === 'durable') sent++; return result.status; };
  const found = { findByEventId: async id => ({ status: 'found', receipt: { eventId: id, durableAt: T1 } }) };
  assert.equal(sendIf(await E.resolveUnknownAppend('evt-x', found)), 'durable');
  assert.equal(sent, 1);
  assert.equal(sendIf(await E.resolveUnknownAppend('evt-x', { findByEventId: async () => ({ status: 'absent', complete: true }) })), 'absent');
  assert.equal(sendIf(await E.resolveUnknownAppend('evt-x', { findByEventId: async () => ({ status: 'absent', complete: false }) })), 'unknown');
  assert.equal(sendIf(await E.resolveUnknownAppend('evt-x', { findByEventId: async () => { throw new Error('timeout'); } })), 'unknown');
  assert.equal(sent, 1, 'only a found receipt for the same event releases the body');
  await refusedAsync(() => E.resolveUnknownAppend('evt-x', { findByEventId: async () => ({ status: 'found', receipt: { eventId: 'evt-y', durableAt: T1 } }) }), 'DurabilityReceiptMismatch');
});

def('TEST-E-01 delivery_states R7', () => {
  const m = build(), target = `/dicom-web/studies/${STUDY}/series/${S(STUDY, 1)}/instances/${S(STUDY, 1)}.1`;
  const a = prepare(m, target), b = prepare(m, target), u = a.units[0];
  // One verified byte and 4999 unverified ones, both responses ended: the unit is not delivered as the fixed object.
  const judged = E.judgeDelivery([{ prepared: a, observations: [receipt(a), wrote(u, 0, 1), ended] },
    { prepared: b, observations: [receipt(b), wrote(b.units[0], 1, 5000, null), ended] }]);
  assert.equal(judged.outcome, 'incomplete');
  assert.deepEqual([judged.units[0].status, judged.units[0].confirmed, judged.units[0].verified], ['unverified', [[0, 5000]], [[0, 1]]]);
  // Each range keeps who verified it: the prefix by read-1 in response a, the rest by nobody.
  assert.deepEqual(judged.units[0].ranges.map(r => [r.start, r.end, r.response, r.confirmed, r.verifiedBy?.readId ?? null]),
    [[0, 1, a.eventId, true, 'read-1'], [1, 5000, b.eventId, true, null]]);
  // Verified ranges that are written in an aborted response do not count either.
  const c = prepare(m, target), d = prepare(m, target);
  assert.equal(E.judgeDelivery([{ prepared: c, observations: [receipt(c), wrote(c.units[0], 0, 2500), aborted] },
    { prepared: d, observations: [receipt(d), wrote(d.units[0], 2500, 5000), ended] }]).units[0].status, 'unconfirmed');
  // Two ranges, each written from its own verified read, together complete the unit.
  const e = prepare(m, target), f = prepare(m, target);
  const both = E.judgeDelivery([{ prepared: e, observations: [receipt(e), wrote(e.units[0], 0, 2500, verified(u, u.sha256, 'read-e')), ended] },
    { prepared: f, observations: [receipt(f), wrote(f.units[0], 2500, 5000, verified(u, u.sha256, 'read-f')), ended] }]);
  assert.deepEqual([both.outcome, both.units[0].verified], ['complete', [[0, 5000]]]);
  // A generated body has no fixed hash and cannot claim one.
  const md = prepare(m, `/dicom-web/studies/${STUDY}/series/${S(STUDY, 1)}/metadata`);
  refused(() => E.judgeDelivery([{ prepared: md, observations: [receipt(md), { stage: 'unit-length', unit: md.units[0].key, length: 10 },
    wrote(md.units[0], 0, 10, verified(md.units[0], h('generated'))), ended] }]), 'VerificationNotApplicable');
});
def('TEST-E-01 delivery_states R8', () => {
  const m = build(), target = `/dicom-web/studies/${STUDY}/series/${S(STUDY, 1)}/instances/${S(STUDY, 1)}.1`;
  const openA = { openingId: 'open-A', accountGeneration: 1, sequence: 1 };
  const halves = (a, b) => E.judgeDelivery([{ prepared: a, observations: [receipt(a), wrote(a.units[0], 0, 2500), ended] },
    { prepared: b, observations: [receipt(b), wrote(b.units[0], 2500, 5000), ended] }]);
  const first = prepare(m, target, { opening: openA });
  // Another account generation and opening, the same account in a later opening (A to B to A), a load serving no opening,
  // and a processor relation are each a different receiver.
  refused(() => halves(first, prepare(m, target, { opening: { openingId: 'open-B', accountGeneration: 2, sequence: 3 } })), 'DeliveryContextMismatch');
  refused(() => halves(first, prepare(m, target, { opening: { ...openA, sequence: 2 } })), 'DeliveryContextMismatch');
  refused(() => halves(first, prepare(m, target, { opening: null, accountGeneration: 1 })), 'DeliveryContextMismatch');
  refused(() => halves(first, prepare(m, target, { provision: E.checkProvisionBasis(processor()),
    authorization: { studyUid: STUDY, institution: 'reading-center', accountGeneration: 1 } })), 'DeliveryContextMismatch');
  refused(() => halves(first, first), 'DuplicateResponse');
  // The same receiver resumes normally, and the judgement names that receiver.
  const same = allowed(() => halves(first, prepare(m, target, { opening: openA })));
  assert.deepEqual([same.outcome, { ...same.receiver }], ['complete',
    { relation: 'same-institution', institution: INSTITUTION, accountGeneration: 1, openingId: 'open-A', sequence: 1 }]);
  // An opening of one account generation is not served on another generation's 204.
  refused(() => prepare(m, target, { opening: openA, accountGeneration: 2 }), 'AuthorizationScopeMismatch');
});

// ── TEST-E-02 manifest_sources ──────────────────────────────────────────────────────────────────────────────────
def('TEST-E-02 manifest_sources A1', () => {
  const objects = studyObjects(), input = manifestInput(objects), before = structuredClone(input);
  const m = M.buildImageManifest(input);
  assert.deepEqual(input, before, 'the input listing is not modified');
  assert.equal(m.objects.length, objects.length);
  const byUid = Object.fromEntries(m.objects.map(o => [o.sopInstanceUid, o]));
  assert.deepEqual(byUid[DBT].frames.map(f => f.number), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual([byUid[DBT].mammography.kind, byUid[SYNTH].mammography.kind], ['dbt', 'generated-2d']);
  assert.deepEqual(byUid[SYNTH].derivation, { kind: 'derived', sources: [{ studyUid: STUDY, seriesUid: S(STUDY, 3), sopInstanceUid: DBT }] });
  assert.deepEqual(byUid[S(STUDY, 6) + '.1'].provenance, external());
  assert.deepEqual(m.objects.map(o => M.recordKindOf(o)).sort(),
    ['external-sr-seg', 'image', 'image', 'image', 'image', 'image', 'image', 'manual-sr', 'pdf']);
  assert.deepEqual(m.decoders.map(d => d.id), ['jpeg-2000', 'jpeg-baseline', 'native']);
  assert.deepEqual(m.viewer, VIEWER);
  // The digest names the content: another page split or listing order of the same objects is the same version.
  const reordered = M.buildImageManifest(manifestInput([...objects].reverse(), { split: 2 }));
  assert.equal(reordered.sha256, m.sha256);
  const changed = studyObjects(); changed[1] = { ...changed[1], sha256: h('changed') };
  assert.notEqual(build(changed).sha256, m.sha256);
});
def('TEST-E-02 manifest_sources A2', () => {
  const objects = studyObjects(), dup = objects[0];
  const m = M.buildImageManifest(manifestInput(objects, { pages: [{ cursor: null, next: 'p2', objects: objects.slice(0, 5) },
    { cursor: 'p2', next: null, objects: [dup, ...objects.slice(5)] }] }));
  assert.equal(m.objects.length, objects.length);
  const raw = { ...pixel(STUDY, S(STUDY, 8), S(STUDY, 8) + '.1', SC('66')), imageType: null, derivation: { kind: 'not-image' } };
  const odd = pixel(STUDY, S(STUDY, 9), S(STUDY, 9) + '.1', SC('2'), { ts: TS.unknown });
  const withOdd = allowed(() => build([...studyObjects(), raw, odd]));
  const flagged = Object.fromEntries(withOdd.objects.map(o => [o.sopInstanceUid, o.unsupported]));
  assert.equal(flagged[raw.sopInstanceUid], 'UnknownObjectFormat');
  assert.equal(flagged[odd.sopInstanceUid], 'UnknownTransferSyntax');
  refused(() => prepare(withOdd, `/dicom-web/studies/${STUDY}/series/${S(STUDY, 8)}/instances/${raw.sopInstanceUid}`), 'UnknownObjectFormat');
  refused(() => prepare(withOdd, `/dicom-web/studies/${STUDY}/series/${S(STUDY, 9)}/instances/${odd.sopInstanceUid}/frames/1`), 'UnknownTransferSyntax');
  // The rest of the study opens as before; a whole-study retrieve names what it left out.
  assert.equal(allowed(() => prepare(withOdd, `/dicom-web/studies/${STUDY}/series/${S(STUDY, 1)}/instances/${S(STUDY, 1)}.1`)).units.length, 1);
  const all = allowed(() => prepare(withOdd, `/dicom-web/studies/${STUDY}`));
  assert.equal(all.units.length, objects.length);
  assert.deepEqual(all.excluded.map(x => x.reason).sort(), ['UnknownObjectFormat', 'UnknownTransferSyntax']);
});
def('TEST-E-02 manifest_sources A3', () => {
  const m = build(), xa = m.objects.find(o => o.family === 'xa');
  assert.deepEqual(xa.frames.map(f => f.number), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(xa.timing, { source: 'frame-time-vector', vectorMs: [0, 66, 67, 66, 67, 66, 67, 66] });
  assert.equal(xa.timingVerified, true);
  const short = studyObjects(); short[5] = { ...short[5], timing: { source: 'frame-time-vector', vectorMs: [0, 66, 67] } };
  const kept = build(short).objects.find(o => o.family === 'xa');
  assert.deepEqual(kept.timing.vectorMs, [0, 66, 67], 'a wrong-length vector is kept as stored, not padded or averaged');
  assert.equal(kept.timingVerified, false);
  const fixed = studyObjects(); fixed[5] = { ...fixed[5], timing: { source: 'frame-time', frameTimeMs: 66.7 } };
  assert.equal(build(fixed).objects.find(o => o.family === 'xa').timingVerified, true);
  const none = studyObjects(); none[5] = { ...none[5], timing: { source: 'none' } };
  assert.equal(build(none).objects.find(o => o.family === 'xa').timingVerified, false);
  const bad = studyObjects(); bad[5] = { ...bad[5], timing: { source: 'frame-time-vector', vectorMs: [0, Number.NaN] } };
  refused(() => build(bad), 'InvalidFrameTiming');
});
def('TEST-E-02 manifest_sources R1', () => {
  const objects = studyObjects(), twin = { ...objects[0], sha256: h('same uid, other bytes') };
  refused(() => M.buildImageManifest(manifestInput(objects, { pages: [{ cursor: null, next: 'p2', objects: objects.slice(0, 5) },
    { cursor: 'p2', next: null, objects: [twin, ...objects.slice(5)] }] })), 'DuplicateObjectConflict');
  const resized = { ...objects[0], bytes: objects[0].bytes + 1 };
  refused(() => M.buildImageManifest(manifestInput([...objects, resized])), 'DuplicateObjectConflict');
});
def('TEST-E-02 manifest_sources R2', () => {
  const lastMissing = studyObjects(); lastMissing[3] = { ...lastMissing[3], frames: frameSet(DBT, 5) };
  refused(() => build(lastMissing), 'FrameSetIncomplete');
  const gap = studyObjects(); gap[5] = { ...gap[5], frames: frameSet(S(STUDY, 5) + '.1', 8).filter(f => f.number !== 4) };
  refused(() => build(gap), 'FrameSetIncomplete');
  const repeated = studyObjects(); repeated[3] = { ...repeated[3], frames: [...frameSet(DBT, 6), frameSet(DBT, 6)[5]] };
  refused(() => build(repeated), 'FrameSetConflict');
  const docFrames = studyObjects(); docFrames[6] = { ...docFrames[6], declaredFrameCount: 1, frames: frameSet('x', 1) };
  refused(() => build(docFrames), 'FrameSetIncomplete');
  // With all frames present the same object is accepted.
  assert.equal(build().objects.find(o => o.sopInstanceUid === DBT).frames.length, 6);
});
def('TEST-E-02 manifest_sources R3', () => {
  const objects = studyObjects();
  refused(() => M.buildImageManifest(manifestInput(objects, { pages: [{ cursor: null, next: 'p2', objects: objects.slice(0, 5) }] , expected: { series: 7, objects: 9 } })), 'ManifestPageIncomplete');
  refused(() => M.buildImageManifest(manifestInput(objects, { pages: [{ cursor: null, next: 'p2', objects: objects.slice(0, 5) },
    { cursor: 'p3', next: null, objects: objects.slice(5) }] })), 'ManifestPageIncomplete');
  refused(() => M.buildImageManifest(manifestInput(objects, { expected: { series: 7, objects: 10 } })), 'ManifestPageIncomplete');
  refused(() => M.buildImageManifest(manifestInput(objects.slice(1), { expected: { series: 7, objects: 9 } })), 'ManifestPageIncomplete');
  refused(() => M.buildImageManifest(manifestInput(objects, { pages: [] })), 'ManifestPageIncomplete');
});
def('TEST-E-02 manifest_sources R4', () => {
  const cases = [
    [{ kind: 'external', system: 'Vendor AI', receiptEventId: 'import-7' }, 'ExternalSourceRequired'],
    [{ kind: 'external', system: ' ', receiptEventId: 'import-7', signatureEvidence: { status: 'absent' } }, 'ExternalSourceRequired'],
    [{ kind: 'external', system: 'Vendor AI', receiptEventId: 'import-7', signatureEvidence: { status: 'unknown' } }, 'ExternalSourceRequired'],
    [{ kind: 'device', receiptEventId: 'rcpt-sr' }, 'ExternalSourceRequired'],
    [null, 'ObjectSourceRequired'],
  ];
  for (const [provenance, code] of cases) {
    const objects = studyObjects(); objects[6] = { ...objects[6], provenance };
    refused(() => build(objects), code);
  }
  const image = studyObjects(); image[0] = { ...image[0], provenance: { kind: 'product-authored', recordId: 'manual-sr-1' } };
  refused(() => build(image), 'ProvenanceMismatch');
  const pdf = studyObjects(); pdf[8] = { ...pdf[8], provenance: { kind: 'product-authored', recordId: 'x' } };
  refused(() => build(pdf), 'ProvenanceMismatch');
  // The external SR keeps its source evidence; no product signature is added to it.
  assert.deepEqual(build().objects.find(o => o.sopInstanceUid === S(STUDY, 7) + '.1').provenance, external('Referring EMR', { status: 'absent' }));
});
def('TEST-E-02 manifest_sources A4', () => {
  // A Hologic pair as stored: an Intelligent 2D view (Breast Tomosynthesis IOD, one frame) and its 1 mm DBT volume.
  const i2dSeries = S(STUDY, 8), volSeries = S(STUDY, 9), i2d = i2dSeries + '.1', vol = volSeries + '.1';
  const pair = [...studyObjects(), hologicDbt(STUDY, volSeries, vol),
    hologicSynthetic(STUDY, i2dSeries, i2d, 'L', [{ studyUid: STUDY, seriesUid: volSeries, sopInstanceUid: vol }])];
  const m = allowed(() => build(pair));
  const byUid = Object.fromEntries(m.objects.map(o => [o.sopInstanceUid, o]));
  assert.deepEqual([byUid[i2d].family, byUid[i2d].declaredFrameCount, byUid[i2d].mammography.kind, byUid[i2d].mammography.dbtRepresentation],
    ['breast-tomosynthesis', 1, 'generated-2d', null]);
  assert.deepEqual(byUid[i2d].mammography.frameTypes, [I2D_TYPE]);
  assert.deepEqual([byUid[vol].mammography.kind, byUid[vol].mammography.dbtRepresentation, byUid[vol].frames.length], ['dbt', 'slices', 60]);
  // Volumetric Properties decides slices or slabs: GE's 10 mm MIP slabs say SAMPLED; another value stays unspecified.
  const slab = allowed(() => build([...studyObjects(), hologicDbt(STUDY, volSeries, vol, 30, 'L', 'SAMPLED')]));
  assert.equal(slab.objects.find(o => o.sopInstanceUid === vol).mammography.dbtRepresentation, 'slab');
  const other = allowed(() => build([...studyObjects(), hologicDbt(STUDY, volSeries, vol, 30, 'L', 'DISTORTED')]));
  assert.equal(other.objects.find(o => o.sopInstanceUid === vol).mammography.dbtRepresentation, 'unspecified');
  // A generated 2D stored in the Digital Mammography IOD (no Frame Type) is accepted as well.
  assert.equal(build().objects.find(o => o.sopInstanceUid === SYNTH).mammography.kind, 'generated-2d');
});
def('TEST-E-02 manifest_sources R5', () => {
  const series = S(STUDY, 8), i2d = series + '.1', withObject = o => [...studyObjects(), o];
  // A multi-frame tomosynthesis object stays DBT even when every type field says GENERATED_2D: its frame count alone refuses it.
  const multiFrame = hologicSynthetic(STUDY, series, i2d);
  Object.assign(multiFrame, { declaredFrameCount: 60, frames: frameSet(i2d, 60, 10), bytes: 60 * 10 + 4000 });
  refused(() => build(withObject(multiFrame)), 'MammographyKindMismatch');
  // Frame Type that says NONE, mixed Frame Types or no Frame Type: not a device synthetic 2D of the tomosynthesis IOD.
  for (const frameTypes of [[DBT_TYPE], [I2D_TYPE, DBT_TYPE], null]) {
    const o = hologicSynthetic(STUDY, series, i2d);
    o.mammography = { ...o.mammography, frameTypes };
    refused(() => build(withObject(o)), 'MammographyKindMismatch');
  }
  const wrongValue3 = hologicSynthetic(STUDY, series, i2d);
  wrongValue3.imageType = ['DERIVED', 'PRIMARY', 'VOLUME', 'GENERATED_2D'];
  wrongValue3.mammography = { ...wrongValue3.mammography, frameTypes: [wrongValue3.imageType] };
  refused(() => build(withObject(wrongValue3)), 'MammographyKindMismatch');
  // A DBT label on a GENERATED_2D object or on mixed frame types, a 2D label on tomosynthesis, a DBT label on a 2D view.
  const synthAsDbt = hologicSynthetic(STUDY, series, i2d);
  synthAsDbt.mammography = { ...synthAsDbt.mammography, kind: 'dbt' };
  refused(() => build(withObject(synthAsDbt)), 'MammographyKindMismatch');
  const mixedDbt = studyObjects(); mixedDbt[3] = { ...mixedDbt[3], mammography: role('dbt', 'L', [DBT_TYPE, I2D_TYPE], 'VOLUME') };
  refused(() => build(mixedDbt), 'MammographyKindMismatch');
  const asConventional = studyObjects(); asConventional[3] = { ...asConventional[3], mammography: role('conventional-2d', 'L') };
  refused(() => build(asConventional), 'MammographyKindMismatch');
  const flatDbt = studyObjects(); flatDbt[2] = { ...flatDbt[2], mammography: role('dbt', 'R') };
  refused(() => build(flatDbt), 'MammographyKindMismatch');
  // DERIVED\PRIMARY (CMMD) without GENERATED_2D is not synthetic evidence; a Value 3 term is not a plain exposure.
  const derivedOnly = studyObjects(); derivedOnly[2] = { ...derivedOnly[2], mammography: role('generated-2d', 'R') };
  refused(() => build(derivedOnly), 'MammographyKindMismatch');
  const notPlain = studyObjects(); notPlain[2] = { ...notPlain[2], imageType: ['DERIVED', 'PRIMARY', 'TOMOSYNTHESIS'] };
  refused(() => build(notPlain), 'MammographyKindMismatch');
  // A generated 2D comes from tomosynthesis data of the same breast, never from another 2D view.
  const sourceNotTomo = studyObjects();
  sourceNotTomo[4] = { ...sourceNotTomo[4], derivation: { kind: 'derived', sources: [{ studyUid: STUDY, seriesUid: S(STUDY, 2), sopInstanceUid: S(STUDY, 2) + '.1' }] } };
  refused(() => build(sourceNotTomo), 'DerivedSourceMismatch');
  const otherSide = studyObjects(); otherSide[4] = { ...otherSide[4], mammography: role('generated-2d', 'R') };
  refused(() => build(otherSide), 'DerivedSourceMismatch');
  const missingRole = studyObjects(); missingRole[3] = { ...missingRole[3], mammography: null };
  refused(() => build(missingRole), 'MammographyRoleRequired');
  // Unverified is always available: the model may decline to classify, never be forced to guess.
  const unsure = studyObjects(); unsure[3] = { ...unsure[3], mammography: role('unverified', null, null, null, null) };
  assert.equal(allowed(() => build(unsure)).objects.find(o => o.sopInstanceUid === DBT).mammography.kind, 'unverified');
});
def('TEST-E-02 manifest_sources R6', () => {
  const relabel = studyObjects(); relabel[0] = { ...relabel[0], derivation: { kind: 'derived', sources: [] } };
  refused(() => build(relabel), 'DerivationMismatch');
  const asOriginal = studyObjects(); asOriginal[2] = { ...asOriginal[2], derivation: { kind: 'original' } };
  refused(() => build(asOriginal), 'DerivationMismatch');
  const foreign = studyObjects(); foreign[1] = { ...foreign[1], studyUid: OTHER };
  refused(() => build(foreign), 'ObjectStudyMismatch');
  const { 'jpeg-2000': _drop, ...catalog } = CATALOG;
  refused(() => M.buildImageManifest(manifestInput(studyObjects(), { catalog })), 'DecoderAssetMissing');
  const m = build();
  refused(() => M.manifestObject(structuredClone(m), DBT), 'ManifestRequired');
  refused(() => prepare(JSON.parse(JSON.stringify(m)), `/dicom-web/studies/${STUDY}`), 'ManifestRequired');
});

// ── TEST-E-03 basis_and_bypass ──────────────────────────────────────────────────────────────────────────────────
const agreement = (overrides = {}) => ({ agreementId: 'agr-1', processor: 'reading-center', validFrom: T0, validTo: null, terminatedAt: null,
  scope: { studyUids: 'institution-studies', recipient: 'reading-center', purpose: 'reading' },
  document: Object.fromEntries(E.PROCESSOR_DOCUMENT_ITEMS.map(k => [k, true])), disclosure: { method: 'website', since: T0 },
  subProcessors: [], location: 'domestic', ...overrides });
const processor = (agreementOverrides, input = {}) => ({ relation: 'processor', at: T1, managingInstitution: INSTITUTION, recipient: 'reading-center',
  studyUid: STUDY, purpose: 'reading', basis: null, agreement: agreement(agreementOverrides), auditBefore: { eventId: 'audit-before-1' }, ...input });
const consent = (overrides = {}) => ({ kind: 'patient-consent', basisId: 'basis-1', obtainedAt: T0, expiresAt: null, revokedAt: null,
  scope: { studyUids: [STUDY], recipient: 'hospital-b', purpose: 'continuing-care' }, ...overrides });
const thirdParty = (basis, input = {}) => ({ relation: 'third-party-recipient', at: T1, managingInstitution: INSTITUTION, recipient: 'hospital-b',
  studyUid: STUDY, purpose: 'continuing-care', basis, agreement: null, auditBefore: { eventId: 'audit-before-2' }, ...input });
const objectPath = `/dicom-web/studies/${STUDY}/series/${S(STUDY, 1)}/instances/${S(STUDY, 1)}.1`;

def('TEST-E-03 basis_and_bypass A1', () => {
  const m = build(), decision = allowed(() => sameInstitution());
  assert.deepEqual({ ...decision }, { relation: 'same-institution', studyUid: STUDY, managingInstitution: INSTITUTION, at: T1, recipient: null,
    basisId: null, agreementId: null, auditBeforeEventId: null, deliverable: true, refusal: null });
  const spy = { body: 0, prepared: [] }, p = allowed(() => serve(spy, m, 'GET', objectPath));
  assert.deepEqual([spy.body, spy.prepared.length], [1, 1]);
  assert.equal(E.judgeDelivery([{ prepared: p, observations: full(p) }]).outcome, 'complete');
  // Normal reading never asks for consent or a contract: supplying them is a different relation, not an extra step.
  refused(() => E.checkProvisionBasis({ relation: 'same-institution', at: T1, managingInstitution: INSTITUTION, recipient: null, studyUid: STUDY,
    purpose: null, basis: consent(), agreement: null, auditBefore: null }), 'ProvisionRelationMismatch');
});
def('TEST-E-03 basis_and_bypass A2', () => {
  const m = build();
  const d = allowed(() => E.checkProvisionBasis(processor()));
  assert.deepEqual([d.deliverable, d.agreementId, d.auditBeforeEventId], [true, 'agr-1', 'audit-before-1']);
  const processorSpy = { body: 0, prepared: [] };
  allowed(() => serve(processorSpy, m, 'GET', objectPath, processor()));
  assert.equal(processorSpy.body, 1);
  const withSub = processor({ subProcessors: [{ name: 'backup-operator', consentedAt: T0 }] });
  assert.equal(allowed(() => E.checkProvisionBasis(withSub)).deliverable, true);
  // A lawful consent or listed exception is recorded for the Connect request, but no image body leaves in Part 1.
  const lawful = allowed(() => E.checkProvisionBasis(thirdParty(consent())));
  assert.deepEqual([lawful.deliverable, lawful.refusal, lawful.basisId], [false, 'ExternalDeliveryNotEnabled', 'basis-1']);
  const exception = E.checkProvisionBasis(thirdParty({ kind: 'statutory-exception', basisId: 'basis-2', clauseId: 'medical:21-2.1-proviso',
    fact: 'emergency-patient', recordedAt: T0, revokedAt: null, scope: { studyUids: [STUDY], recipient: 'hospital-b', purpose: 'continuing-care' } }));
  assert.equal(exception.refusal, 'ExternalDeliveryNotEnabled');
  bodyNeverStarts(spy => serve(spy, m, 'GET', objectPath, thirdParty(consent())), 'ExternalDeliveryNotEnabled');
});
def('TEST-E-03 basis_and_bypass A3', () => {
  const fields = '0020000D,0020000E,00080018,0008103E,00200013,00280008,00280010,00280011,00280004';
  const r = (target, method = 'GET') => ({ ...E.parseImageRequest(method, target) });
  assert.deepEqual(r(`/dicom-web/studies?StudyInstanceUID=${STUDY}`), { method: 'GET', kind: 'study-query', studyUid: STUDY, seriesUid: null,
    sopInstanceUid: null, frames: null, bulkTag: null, query: { StudyInstanceUID: STUDY } });
  assert.equal(r(`/dicom-web/studies/${STUDY}/instances?includefield=${fields}`).kind, 'instance-query');
  assert.equal(r(`/dicom-web/studies/${STUDY}/instances?includefield=${encodeURIComponent(fields)}`).query.includefield, fields);
  assert.equal(r(`/dicom-web/studies/${STUDY}/series`).kind, 'series-query');
  assert.equal(r(`/dicom-web/studies/${STUDY}/series/${S(STUDY, 1)}/metadata`).kind, 'metadata');
  assert.deepEqual(r(`/dicom-web/studies/${STUDY}/series/${S(STUDY, 3)}/instances/${DBT}/frames/3,1,2`).frames, [3, 1, 2]);
  const preview = r(`/dicom-web/studies/${STUDY}/series/${S(STUDY, 3)}/instances/${DBT}/frames/2/rendered?viewport=256,256&window=40,400,linear`);
  assert.deepEqual([preview.kind, preview.frames, preview.query], ['frame-rendered', [2], { viewport: '256,256', window: '40,400,linear' }]);
  assert.equal(r(`/dicom-web/studies/${STUDY}/series/${S(STUDY, 7)}/instances/${S(STUDY, 7)}.1/rendered`).kind, 'rendered');
  assert.deepEqual([r(`/dicom-web/studies/${STUDY}/series/${S(STUDY, 3)}/instances/${DBT}/bulk/7fe00010`).bulkTag], ['7fe00010']);
  assert.equal(r(`/dicom-web/studies/${STUDY}/series/${S(STUDY, 1)}`, 'HEAD').kind, 'series-retrieve');
  // Each shape maps to an exact delivery scope in the manifest.
  const m = build();
  assert.deepEqual(prepare(m, `/dicom-web/studies/${STUDY}/series/${S(STUDY, 3)}/instances/${DBT}/frames/2/rendered?viewport=256,256`).units.map(u => [u.part, u.frame, u.recordKind]),
    [['derived', 2, 'thumbnail']]);
  assert.deepEqual(prepare(m, `/dicom-web/studies/${STUDY}/series/${S(STUDY, 7)}/instances/${S(STUDY, 7)}.1/rendered`).units.map(u => u.recordKind), ['pdf']);
  assert.equal(prepare(m, `/dicom-web/studies/${STUDY}/series/${S(STUDY, 1)}`).units.length, 2);
});
def('TEST-E-03 basis_and_bypass R1', () => {
  const m = build();
  const cases = [
    [thirdParty(consent({ revokedAt: T0 })), 'BasisRevoked'],
    [thirdParty(consent({ revokedAt: T1 })), 'BasisRevoked'],
    [thirdParty(consent({ expiresAt: T1 })), 'BasisExpired'],
    [thirdParty(consent({ obtainedAt: T2 })), 'BasisNotYetValid'],
    [thirdParty(consent({ scope: { studyUids: [PRIOR], recipient: 'hospital-b', purpose: 'continuing-care' } })), 'ProvisionOutOfScope'],
    [thirdParty(consent({ scope: { studyUids: [STUDY], recipient: 'hospital-c', purpose: 'continuing-care' } })), 'ProvisionOutOfScope'],
    [thirdParty(consent({ scope: { studyUids: [STUDY], recipient: 'hospital-b', purpose: 'marketing' } })), 'ProvisionOutOfScope'],
    [thirdParty(null), 'ConsentOrExceptionRequired'],
    [thirdParty({ kind: 'statutory-exception', basisId: 'b', clauseId: 'hospital-policy', fact: 'emergency-patient', recordedAt: T0, revokedAt: null,
      scope: { studyUids: [STUDY], recipient: 'hospital-b', purpose: 'continuing-care' } }), 'ConsentOrExceptionRequired'],
    [thirdParty({ kind: 'statutory-exception', basisId: 'b', clauseId: 'medical:21-2.1-proviso', fact: 'doctor-thinks-useful', recordedAt: T0, revokedAt: null,
      scope: { studyUids: [STUDY], recipient: 'hospital-b', purpose: 'continuing-care' } }), 'ConsentOrExceptionRequired'],
    [thirdParty({ kind: 'statutory-exception', basisId: 'b', clauseId: 'medical:21-2.1-proviso', fact: 'emergency-patient', recordedAt: T0, revokedAt: null,
      scope: { studyUids: 'institution-studies', recipient: 'hospital-b', purpose: 'continuing-care' } }), 'ProvisionOutOfScope'],
    [thirdParty(consent({ scope: { studyUids: 'institution-studies', recipient: 'hospital-b', purpose: 'continuing-care' } })), 'ProvisionOutOfScope'],
    [thirdParty(consent(), { auditBefore: null }), 'AuditBeforeRequired'],
    [thirdParty(consent(), { recipient: INSTITUTION }), 'ProvisionRelationMismatch'],
  ];
  for (const [input, code] of cases) {
    const before = structuredClone(input);
    bodyNeverStarts(spy => serve(spy, m, 'GET', objectPath, input), code);
    assert.deepEqual(input, before, 'the recorded basis is not modified by a refusal');
  }
});
def('TEST-E-03 basis_and_bypass R2', () => {
  const m = build();
  const { purposeLimit: _gone, ...shortDocument } = agreement().document;
  const cases = [
    [processor({ terminatedAt: T0 }), 'AgreementTerminated'],
    [processor({ validTo: T1 }), 'AgreementInactive'],
    [processor({ validFrom: T2 }), 'AgreementInactive'],
    [processor({ document: { ...agreement().document, liability: false } }), 'AgreementDocumentIncomplete'],
    [processor({ document: shortDocument }), 'AgreementDocumentIncomplete'],
    [processor({ disclosure: null }), 'ProcessorDisclosureMissing'],
    [processor({ disclosure: { method: 'website', since: T2 } }), 'ProcessorDisclosureMissing'],
    [processor({ subProcessors: [{ name: 'cloud-x', consentedAt: null }] }), 'SubProcessingConsentMissing'],
    [processor({ location: 'overseas' }), 'OverseasTransferNotEnabled'],
    [processor({ processor: 'someone-else' }), 'ProvisionOutOfScope'],
    [processor({ scope: { studyUids: [PRIOR], recipient: 'reading-center', purpose: 'reading' } }), 'ProvisionOutOfScope'],
    [processor({}, { agreement: null }), 'ProcessingAgreementRequired'],
    [processor({}, { auditBefore: null }), 'AuditBeforeRequired'],
    [processor({}, { basis: consent() }), 'ProvisionRelationMismatch'],
  ];
  for (const [input, code] of cases) bodyNeverStarts(spy => serve(spy, m, 'GET', objectPath, input), code);
});
def('TEST-E-03 basis_and_bypass R3', () => {
  const orthancId = '0d3e7a1c-5b2f4e11-9a8b7c6d-1e2f3a4b-5c6d7e8f';
  const direct = [`/instances/${orthancId}/file`, `/instances/${orthancId}/pdf`, `/instances/${orthancId}/frames/1/rendered`,
    `/instances/${orthancId}/tags`, `/studies/${orthancId}/archive`, `/series/${orthancId}/media`, '/patients', '/tools/find', '/system',
    '/statistics', '/wado?requestType=WADO', '/dicom-web/servers'];
  for (const target of direct) refused(() => E.parseImageRequest('GET', target), 'DirectOrthancPathRefused');
  const escaped = [`/dicom-web/studies/${STUDY}/../../instances/${orthancId}/file`, `/dicom-web/studies/${STUDY}/%2e%2e/instances`,
    `/dicom-web//studies/${STUDY}`, `/dicom-web/studies/${STUDY}/`, `/DICOM-WEB/studies/${STUDY}`, `http://orthanc:8042/dicom-web/studies/${STUDY}`,
    `/dicom-web/studies/${STUDY}/series/${S(STUDY, 1)}/instances/${S(STUDY, 1)}.1/file`, `/dicom-web/studies/${STUDY}\\x`,
    `/dicom-web/studies/${STUDY}/series/${S(STUDY, 1)}/instances/${S(STUDY, 1)}.1/frames/0`,
    `/dicom-web/studies/${STUDY}/series/${S(STUDY, 1)}/instances/${S(STUDY, 1)}.1/frames/1,1`, `/dicom-web/studies/abc`, '/api/me', '/'];
  for (const target of escaped) refused(() => E.parseImageRequest('GET', target), 'ImagePathRefused');
  for (const method of ['POST', 'DELETE', 'PUT', 'get']) refused(() => E.parseImageRequest(method, `/dicom-web/studies/${STUDY}`), 'ImageMethodRefused');
  for (const target of ['/dicom-web/studies', `/dicom-web/studies?PatientID=SYN-1`, `/dicom-web/studies?StudyInstanceUID=${STUDY}&0020000D=${STUDY}`,
    `${objectPath}?accept=application/octet-stream`, `/dicom-web/studies/${STUDY}/instances?includefield=1&includefield=2`,
    `/dicom-web/studies/${STUDY}/instances?includefield=<script>`, `/dicom-web/studies?StudyInstanceUID=${'1.'.repeat(40)}1`])
    refused(() => E.parseImageRequest('GET', target), 'ImageQueryRefused');
});
def('TEST-E-03 basis_and_bypass R4', () => {
  const m = build(), request = E.parseImageRequest('GET', objectPath);
  const context = (overrides = {}) => ({ eventId: 'evt-r4', cause: 'user-view', at: T1, authorization: { studyUid: STUDY, institution: INSTITUTION, accountGeneration: GENERATION },
    provision: sameInstitution(), opening: null, ...overrides });
  assert.equal(allowed(() => E.prepareDelivery(m, request, context())).units.length, 1);
  // A basis decided earlier is not reused: the consent or agreement may have ended in between.
  refused(() => E.prepareDelivery(m, request, context({ provision: sameInstitution(STUDY, T0) })), 'ProvisionDecisionStale');
  refused(() => E.prepareDelivery(m, request, context({ authorization: { studyUid: PRIOR, institution: INSTITUTION, accountGeneration: GENERATION } })), 'AuthorizationScopeMismatch');
  refused(() => E.prepareDelivery(m, request, context({ authorization: { studyUid: STUDY, institution: 'hospital-b', accountGeneration: GENERATION } })), 'AuthorizationScopeMismatch');
  // A processor's provision is served to the processor it names, not on the hospital's own 204 and not to another body.
  const viaProcessor = E.checkProvisionBasis(processor());
  assert.equal(allowed(() => E.prepareDelivery(m, request, context({ provision: viaProcessor, authorization: { studyUid: STUDY, institution: 'reading-center', accountGeneration: GENERATION } }))).relation, 'processor');
  refused(() => E.prepareDelivery(m, request, context({ provision: viaProcessor })), 'AuthorizationScopeMismatch');
  refused(() => E.prepareDelivery(m, request, context({ provision: viaProcessor, authorization: { studyUid: STUDY, institution: 'hospital-b', accountGeneration: GENERATION } })), 'AuthorizationScopeMismatch');
  refused(() => E.prepareDelivery(m, { ...request, kind: 'study-retrieve' }, context()), 'ImageRequestRequired');
  refused(() => E.prepareDelivery(m, request, context({ provision: { ...sameInstitution() } })), 'ProvisionDecisionRequired');
  refused(() => E.prepareDelivery(m, request, context({ provision: sameInstitution(PRIOR) })), 'ProvisionOutOfScope');
  for (const [target, code] of [
    [`/dicom-web/studies/${PRIOR}/series/${S(STUDY, 1)}/instances/${S(STUDY, 1)}.1`, 'ScopeOutsideManifest'],
    [`/dicom-web/studies/${STUDY}/series/${S(STUDY, 2)}/instances/${S(STUDY, 1)}.1`, 'ScopeOutsideManifest'],
    [`/dicom-web/studies/${STUDY}/series/${S(STUDY, 1)}/instances/${S(STUDY, 1)}.9`, 'ScopeOutsideManifest'],
    [`/dicom-web/studies/${STUDY}/series/${S(STUDY, 3)}/instances/${DBT}/frames/7`, 'FrameOutOfManifest'],
    [`/dicom-web/studies/${STUDY}/series/${S(STUDY, 6)}/instances/${S(STUDY, 6)}.1/frames/1`, 'ScopeOutsideManifest'],
    [`/dicom-web/studies/${STUDY}/series/${S(STUDY, 6)}/instances/${S(STUDY, 6)}.1/rendered`, 'ScopeOutsideManifest'],
  ]) bodyNeverStarts(spy => serve(spy, m, 'GET', target), code);
});

def('TEST-E-03 basis_and_bypass R5', () => {
  // The refusal check itself: a body or a plan that started before the refusal is reported, not hidden by the throw.
  const late = (mark) => spy => { mark(spy); throw Object.assign(new Error('late refusal'), { code: 'LateRefusal' }); };
  for (const mark of [spy => { spy.body++; }, spy => { spy.prepared.push({}); }]) {
    let caught = null;
    try { bodyNeverStarts(late(mark), 'LateRefusal'); } catch (e) { caught = e; }
    assert.equal(caught?.code, 'ERR_ASSERTION', 'a body or plan started before a refusal must fail the refusal check');
  }
  bodyNeverStarts(() => { throw Object.assign(new Error('early refusal'), { code: 'EarlyRefusal' }); }, 'EarlyRefusal');
  // On the product path a refused provision issues no plan and starts no body.
  bodyNeverStarts(spy => serve(spy, build(), 'GET', objectPath, thirdParty(consent({ revokedAt: T0 }))), 'BasisRevoked');
});

// ── TEST-E-04 offline_ready ─────────────────────────────────────────────────────────────────────────────────────
const TEXTS = [{ recordId: 'report-1', versionId: 'v3', bytes: 1200, sha256: h('report-1@v3') }];
function bundle(current = build(), prior = build(studyObjects(PRIOR)), opts = {}) {
  return E.planOfflineBundle({ bundleId: 'bundle-1', current, comparisons: { selected: opts.selected ?? [PRIOR], manifests: opts.manifests ?? [prior] },
    texts: opts.texts ?? TEXTS });
}
function device(plan, opts = {}) {
  const parts = plan.parts.filter(p => !(opts.drop ?? []).includes(p.kind) && !(opts.dropKeys ?? []).includes(p.key));
  return { bundleId: plan.bundleId, planSha256: opts.planSha256 ?? plan.sha256,
    verified: opts.verified ?? parts.map(p => ({ key: p.key, bytes: p.bytes, sha256: (opts.alter ?? {})[p.key] ?? p.sha256 })),
    storage: opts.storage ?? { freeBytes: plan.totalBytes * 2, requiredBytes: plan.totalBytes + 1 }, journal: opts.journal ?? { freeBytes: 4096, requiredBytes: 1024 } };
}
def('TEST-E-04 offline_ready A1', () => {
  const plan = bundle();
  assert.deepEqual(plan.manifests.map(m => m.role), ['current', 'comparison']);
  assert.deepEqual([...new Set(plan.parts.map(p => p.kind))], ['object', 'text', 'decoder', 'viewer']);
  assert.equal(plan.parts.filter(p => p.kind === 'object').length, 18);
  const state = device(plan);
  assert.deepEqual({ ...E.offlineReadiness(plan, state) }, { ready: true, reasons: [] });
  // After a restart nothing in memory survives: the same stored facts rebuild the same plan and the same verdict.
  const replay = JSON.parse(JSON.stringify({ current: manifestInput(), prior: manifestInput(studyObjects(PRIOR)), state }));
  const again = E.planOfflineBundle({ bundleId: 'bundle-1', current: M.buildImageManifest(replay.current),
    comparisons: { selected: [PRIOR], manifests: [M.buildImageManifest(replay.prior)] }, texts: TEXTS });
  assert.equal(again.sha256, plan.sha256);
  assert.equal(E.offlineReadiness(again, replay.state).ready, true);
});
def('TEST-E-04 offline_ready A2', () => {
  const grant = { grantId: 'grant-1', notAfter: T2, endedAt: null };
  assert.deepEqual({ ...E.offlineAccess(grant, T1) }, { viewAllowed: true, reason: 'grant-active', queuePreserved: true });
  assert.deepEqual({ ...E.offlineAccess(grant, T2) }, { viewAllowed: false, reason: 'grant-expired', queuePreserved: true });
  assert.deepEqual({ ...E.offlineAccess({ ...grant, endedAt: T1 }, T1) }, { viewAllowed: false, reason: 'grant-ended', queuePreserved: true });
});
def('TEST-E-04 offline_ready A3', () => {
  const who = { id: 'u-1', issuer: 'https://identity.example.test', subject: 'sub-u-1' };
  const offline = [1, 2].map(n => E.sealOfflineView({ eventId: `off-${n}`, deviceId: 'device-7', deviceSequence: n, occurredAt: n === 1 ? T0 : T1,
    userId: who, grantId: 'grant-1', studyUid: STUDY, sopInstanceUid: DBT, frame: n }));
  assert.deepEqual(offline.map(r => [r.occurredAt, r.clock, r.deviceSequence, r.trustedProxyIp]),
    [[T0, 'device', 1, { status: 'unresolved', reason: 'not-observed' }], [T1, 'device', 2, { status: 'unresolved', reason: 'not-observed' }]]);
  const snapshot = JSON.stringify(offline);
  const joined = allowed(() => E.reconnectRecord(offline, { eventId: 'reconnect-1', deviceId: 'device-7', at: T2, trustedProxyIp: { address: '10.0.0.8', source: 'trusted-proxy' } }));
  assert.deepEqual(joined.reconnect, { eventId: 'reconnect-1', deviceId: 'device-7', at: T2,
    trustedProxyIp: { status: 'known', value: { address: '10.0.0.8', source: 'trusted-proxy' } }, relatedOfflineEventIds: ['off-1', 'off-2'] });
  assert.deepEqual(joined.offline.map(r => r.trustedProxyIp), [{ status: 'unresolved', reason: 'not-observed' }, { status: 'unresolved', reason: 'not-observed' }],
    'the reconnect address is not written back into the offline records');
  assert.deepEqual(joined.offline.map(r => r.occurredAt), [T0, T1]);
  assert.equal(JSON.stringify(offline), snapshot);
});
def('TEST-E-04 offline_ready R1', () => {
  const plan = bundle();
  const thumbs = plan.parts.filter(p => p.kind === 'object').map(p => ({ key: p.key.replace('object:', 'thumbnail:'), bytes: 900, sha256: h(p.key + ':thumb') }));
  const onlyThumbs = E.offlineReadiness(plan, device(plan, { verified: [...thumbs, ...plan.parts.filter(p => p.kind !== 'object').map(p => ({ key: p.key, bytes: p.bytes, sha256: p.sha256 }))] }));
  assert.equal(onlyThumbs.ready, false);
  assert.equal(onlyThumbs.reasons.filter(r => r.code === 'object-missing').length, 18);
  // One DBT frame short on the device: the stored object differs from the fixed manifest by size and hash.
  const key = `object:${STUDY}/${DBT}`, part = plan.parts.find(p => p.key === key);
  const short = device(plan, { verified: plan.parts.map(p => p.key === key ? { key, bytes: part.bytes - 1000, sha256: h('five frames') } : { key: p.key, bytes: p.bytes, sha256: p.sha256 }) });
  assert.deepEqual({ ...E.offlineReadiness(plan, short) }, { ready: false, reasons: [{ code: 'part-mismatch', key }] });
});
def('TEST-E-04 offline_ready R2', () => {
  const plan = bundle(build(), undefined, { manifests: [] });
  assert.deepEqual(plan.missingComparisons, [PRIOR]);
  assert.deepEqual(E.offlineReadiness(plan, device(plan)).reasons, [{ code: 'comparison-missing', key: PRIOR }]);
  const full = bundle();
  assert.deepEqual(E.offlineReadiness(full, device(full, { storage: { freeBytes: full.totalBytes, requiredBytes: full.totalBytes + 1 } })).reasons,
    [{ code: 'storage-insufficient', key: null }]);
  assert.deepEqual(E.offlineReadiness(full, device(full, { journal: { freeBytes: 10, requiredBytes: 11 } })).reasons, [{ code: 'journal-insufficient', key: null }]);
  assert.deepEqual(E.offlineReadiness(full, device(full, { planSha256: h('older plan') })).reasons, [{ code: 'bundle-stale', key: null }]);
  const text = E.offlineReadiness(full, device(full, { drop: ['text'] }));
  assert.deepEqual(text.reasons, [{ code: 'text-missing', key: 'text:report-1@v3' }]);
});
def('TEST-E-04 offline_ready R3', () => {
  const plan = bundle();
  const noDecoder = E.offlineReadiness(plan, device(plan, { dropKeys: ['decoder:jpeg-2000@jpeg-2000-1.0.0'] }));
  assert.deepEqual({ ...noDecoder }, { ready: false, reasons: [{ code: 'decoder-missing', key: 'decoder:jpeg-2000@jpeg-2000-1.0.0' }] });
  const otherDecoder = E.offlineReadiness(plan, device(plan, { alter: { 'decoder:jpeg-baseline@jpeg-baseline-1.0.0': h('other build') } }));
  assert.deepEqual(otherDecoder.reasons, [{ code: 'part-mismatch', key: 'decoder:jpeg-baseline@jpeg-baseline-1.0.0' }]);
  const noViewer = E.offlineReadiness(plan, device(plan, { drop: ['viewer'] }));
  assert.deepEqual(noViewer.reasons, [{ code: 'viewer-missing', key: `viewer:${VIEWER.id}@${VIEWER.version}` }]);
});
def('TEST-E-04 offline_ready R4', () => {
  refused(() => bundle(build(), M.buildImageManifest(manifestInput(studyObjects(PRIOR), { patient: { ...PATIENT, patientId: 'SYN-2' } }))), 'ComparisonPatientMismatch');
  refused(() => bundle(build(), M.buildImageManifest(manifestInput(studyObjects(PRIOR), { institution: 'hospital-b' }))), 'ComparisonPatientMismatch');
  refused(() => bundle(build(), build(studyObjects(OTHER))), 'ComparisonNotSelected');
  refused(() => bundle(build(), build(studyObjects(PRIOR)), { selected: [PRIOR, STUDY] }), 'ComparisonSelectionInvalid');
  const plan = bundle();
  refused(() => E.offlineReadiness(plan, device(plan, { storage: { freeBytes: plan.totalBytes * 2, requiredBytes: plan.totalBytes - 1 } })), 'StorageRequirementInconsistent');
  refused(() => E.offlineReadiness(structuredClone(plan), device(plan)), 'OfflinePlanRequired');
  const who = { id: 'u-1', issuer: 'https://identity.example.test', subject: 'sub-u-1' };
  const seal = (n, deviceId = 'device-7') => E.sealOfflineView({ eventId: `off-${n}`, deviceId, deviceSequence: n, occurredAt: T0, userId: who, grantId: 'grant-1',
    studyUid: STUDY, sopInstanceUid: null, frame: null });
  const ip = { address: '10.0.0.8', source: 'trusted-proxy' };
  refused(() => E.reconnectRecord([seal(2), seal(1)], { eventId: 'r', deviceId: 'device-7', at: T2, trustedProxyIp: ip }), 'OfflineSequenceConflict');
  refused(() => E.reconnectRecord([seal(1), seal(2, 'device-8')], { eventId: 'r', deviceId: 'device-7', at: T2, trustedProxyIp: ip }), 'OfflineDeviceMismatch');
  refused(() => E.reconnectRecord([{ ...seal(1) }], { eventId: 'r', deviceId: 'device-7', at: T2, trustedProxyIp: ip }), 'OfflineRecordRequired');
  refused(() => E.reconnectRecord([seal(1)], { eventId: 'r', deviceId: 'device-7', at: T2, trustedProxyIp: { address: 'client-said', source: 'trusted-proxy' } }), 'TrustedProxyIpRequired');
});

def('TEST-E-04 offline_ready R5', () => {
  const odd = pixel(STUDY, S(STUDY, 9), S(STUDY, 9) + '.1', SC('2'), { ts: TS.unknown });
  const current = build([...studyObjects(), odd]);
  // Online the object is refused by name and the rest of the study opens as before.
  refused(() => prepare(current, `/dicom-web/studies/${STUDY}/series/${S(STUDY, 9)}/instances/${odd.sopInstanceUid}`), 'UnknownTransferSyntax');
  assert.equal(allowed(() => prepare(current, objectPath)).units.length, 1);
  // Offline Ready claims the whole reading set: with that object left out of the copy it is not ready, by name.
  const plan = bundle(current);
  assert.deepEqual(plan.excluded.map(x => ({ ...x })), [{ studyUid: STUDY, sopInstanceUid: odd.sopInstanceUid, reason: 'UnknownTransferSyntax' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(E.offlineReadiness(plan, device(plan)))),
    { ready: false, reasons: [{ code: 'object-unsupported', key: `object:${STUDY}/${odd.sopInstanceUid}` }] });
});

// ── TEST-E-05 display_epoch ─────────────────────────────────────────────────────────────────────────────────────
const openingFor = (m, overrides = {}) => ({ openingId: 'open-1', accountGeneration: 4, sequence: 3, studyUid: m.studyUid, manifestSha256: m.sha256, closedAt: null, ...overrides });
const report = (m, overrides = {}) => ({ openingId: 'open-1', accountGeneration: 4, sequence: 3, studyUid: m.studyUid, manifestSha256: m.sha256,
  sopInstanceUid: DBT, frame: 2, source: 'network', cause: 'user-view', deliveryEventId: 'evt-frames-1', reportedAt: T1, ...overrides });
const framesPath = `/dicom-web/studies/${STUDY}/series/${S(STUDY, 3)}/instances/${DBT}/frames/1,2,3`;
const viewing = (m, overrides = {}, eventId = 'evt-frames-1', target = framesPath, method = 'GET') =>
  prepare(m, target, { eventId, method, opening: { openingId: 'open-1', accountGeneration: 4, sequence: 3, ...overrides.opening }, cause: overrides.cause ?? 'user-view' });
def('TEST-E-05 display_epoch A1', () => {
  const m = build(), now = openingFor(m), delivered = viewing(m);
  const net = allowed(() => E.classifyDisplayReport(now, m, report(m), delivered));
  assert.deepEqual({ ...net }, { action: 'client-shown', openingId: 'open-1', accountGeneration: 4, sequence: 3, studyUid: STUDY, manifestSha256: m.sha256,
    unitKey: `frame:${DBT}#2`, source: 'network', relatedEventId: 'evt-frames-1', reportedAt: T1 });
  // Showing the same frame again from cache is a display too and is recorded; it names no new delivery.
  const cached = allowed(() => E.classifyDisplayReport(now, m, report(m, { source: 'cache', deliveryEventId: null, reportedAt: T2 }), null));
  assert.deepEqual([cached.action, cached.source, cached.relatedEventId, cached.reportedAt], ['client-shown', 'cache', null, T2]);
  const offline = allowed(() => E.classifyDisplayReport(now, m, report(m, { source: 'offline-store', deliveryEventId: null, frame: null, sopInstanceUid: S(STUDY, 1) + '.1' }), null));
  assert.deepEqual([offline.source, offline.unitKey], ['offline-store', `object:${S(STUDY, 1)}.1`]);
  // A whole-object delivery covers any of its frames.
  const whole = viewing(m, {}, 'evt-object-1', `/dicom-web/studies/${STUDY}/series/${S(STUDY, 3)}/instances/${DBT}`);
  assert.equal(allowed(() => E.classifyDisplayReport(now, m, report(m, { frame: 6, deliveryEventId: 'evt-object-1' }), whole)).unitKey, `frame:${DBT}#6`);
});
def('TEST-E-05 display_epoch A2', () => {
  const m = build(), now = openingFor(m), shown = allowed(() => E.classifyDisplayReport(now, m, report(m), viewing(m)));
  const ack = allowed(() => E.acceptExplicitAck(now, shown, { openingId: 'open-1', accountGeneration: 4, sequence: 3, at: T2 }));
  assert.deepEqual({ ...ack }, { action: 'explicit-ack', openingId: 'open-1', accountGeneration: 4, sequence: 3, unitKey: `frame:${DBT}#2`, relatedShownAt: T1, at: T2 });
  assert.notEqual(ack.action, shown.action);
});
def('TEST-E-05 display_epoch R1', () => {
  const m = build(), now = openingFor(m), delivered = viewing(m);
  const show = (overrides, delivery = delivered, opening = now) => E.classifyDisplayReport(opening, m, report(m, overrides), delivery);
  refused(() => show({ cause: 'background-fetch' }), 'BackgroundIsNotDisplay');
  refused(() => show({ cause: 'service-job' }), 'BackgroundIsNotDisplay');
  // A -> B -> A: the late report of the first opening of study A arrives while A is open again (sequence 3).
  refused(() => show({ sequence: 1 }), 'StaleOpeningRefused');
  refused(() => show({ accountGeneration: 3 }), 'StaleOpeningRefused');
  refused(() => show({ openingId: 'open-0' }), 'StaleOpeningRefused');
  refused(() => show({ manifestSha256: h('older version') }), 'ManifestVersionMismatch');
  refused(() => show({}, delivered, openingFor(m, { closedAt: T1 })), 'OpeningClosed');
  refused(() => show({ deliveryEventId: null }), 'DisplaySourceMismatch');
  refused(() => show({ source: 'cache' }), 'DisplaySourceMismatch');
  refused(() => show({ source: 'cache', deliveryEventId: null }, delivered), 'DisplaySourceMismatch');
  refused(() => show({ frame: 7 }), 'FrameOutOfManifest');
  refused(() => show({ sopInstanceUid: S(OTHER, 1) + '.1' }), 'ScopeOutsideManifest');
  // The delivery a network display names must be this opening's reading-view delivery of these pixels.
  refused(() => show({}, null), 'DisplayDeliveryMismatch');
  refused(() => show({}, viewing(m, { opening: { sequence: 1 } })), 'DisplayDeliveryMismatch');
  refused(() => show({}, viewing(m, { cause: 'background-fetch' })), 'DisplayDeliveryMismatch');
  refused(() => show({ frame: 5 }), 'DisplayDeliveryMismatch');
  refused(() => show({}, viewing(m, {}, 'evt-frames-1', `/dicom-web/studies/${STUDY}/series/${S(STUDY, 3)}/instances/${DBT}/metadata`)), 'DisplayDeliveryMismatch');
  refused(() => show({}, viewing(m, {}, 'evt-other')), 'DisplayDeliveryMismatch');
  refused(() => show({}, structuredClone(delivered)), 'DisplayDeliveryMismatch');
});
def('TEST-E-05 display_epoch R2', () => {
  const m = build(), earlier = openingFor(m, { accountGeneration: 3 });
  const shownEarlier = E.classifyDisplayReport(earlier, m, report(m, { accountGeneration: 3 }), viewing(m, { opening: { accountGeneration: 3 } }));
  const now = openingFor(m);
  refused(() => E.acceptExplicitAck(now, shownEarlier, { openingId: 'open-1', accountGeneration: 4, sequence: 3, at: T2 }), 'StaleAckRefused');
  refused(() => E.acceptExplicitAck(now, shownEarlier, { openingId: 'open-1', accountGeneration: 3, sequence: 3, at: T2 }), 'StaleAckRefused');
  const shown = E.classifyDisplayReport(now, m, report(m), viewing(m));
  refused(() => E.acceptExplicitAck(now, shown, { openingId: 'open-1', accountGeneration: 4, sequence: 2, at: T2 }), 'StaleAckRefused');
  refused(() => E.acceptExplicitAck(now, { ...shown }, { openingId: 'open-1', accountGeneration: 4, sequence: 3, at: T2 }), 'AckWithoutDisplay');
  refused(() => E.acceptExplicitAck(openingFor(m, { closedAt: T2 }), shown, { openingId: 'open-1', accountGeneration: 4, sequence: 3, at: T2 }), 'OpeningClosed');
});

def('TEST-E-05 display_epoch R3', () => {
  const m = build(), now = openingFor(m), object = `/dicom-web/studies/${STUDY}/series/${S(STUDY, 3)}/instances/${DBT}`;
  const show = (delivery, overrides = {}) => E.classifyDisplayReport(now, m, report(m, { deliveryEventId: delivery.eventId, ...overrides }), delivery);
  // HEAD carries no body; PixelSpacing (0028,0030) as bulk data is a header attribute: neither shows pixels.
  refused(() => show(viewing(m, {}, 'evt-head', object, 'HEAD')), 'DisplayDeliveryMismatch');
  refused(() => show(viewing(m, {}, 'evt-spacing', object + '/bulk/00280030')), 'DisplayDeliveryMismatch');
  refused(() => show(viewing(m, {}, 'evt-meta', object + '/metadata')), 'DisplayDeliveryMismatch');
  // The Pixel Data bulk and a whole-object GET are what the reader saw; a PDF's encapsulated document likewise.
  assert.equal(allowed(() => show(viewing(m, {}, 'evt-pixels', object + '/bulk/7fe00010'))).unitKey, `frame:${DBT}#2`);
  assert.equal(allowed(() => show(viewing(m, {}, 'evt-object', object))).relatedEventId, 'evt-object');
  const pdf = S(STUDY, 7) + '.1';
  assert.equal(allowed(() => show(viewing(m, {}, 'evt-pdf', `/dicom-web/studies/${STUDY}/series/${S(STUDY, 7)}/instances/${pdf}/bulk/00420011`),
    { sopInstanceUid: pdf, frame: null })).unitKey, `object:${pdf}`);
});

// Every declared case has exactly one body and nothing undeclared runs; a mismatch stops the file before any case starts.
assert.deepEqual([...registered].sort(), [...CASES].sort());
