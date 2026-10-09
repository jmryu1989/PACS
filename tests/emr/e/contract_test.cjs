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
 * REQ-D735-CLASS/SOURCE -> RISK-D735-MISCLASS/SOURCE -> TEST-D735-*: every case of the shared mammography table
 * tests/emr/e/rule-cases.json (D744-2 consult, also bound by E-MG) runs through buildImageManifest, one test per case ID,
 * and every expected key is compared. The billion-frame resource case checks manifest refusal of an incomplete
 * inventory and compares the public header classifier, without allocating a billion synthetic frame digests.
 * The table is byte-pinned (SHA-256 below): its identity is the requirement that
 * both units judge the same headers, so a changed table must fail here rather than be followed silently (AGENTS 1-B.14).
 * The adapter only moves tags into the manifest input (identity, frame count, Image Type, synthetic digests); it never
 * fills a classification fact from the expected values.
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
  'TEST-E-02 manifest_sources A4 the stored header decides the mammography class; a caller label is only recorded, and the rule version and every verdict are manifest content',
  'TEST-E-02 manifest_sources R1 the same SOP with different bytes is refused',
  'TEST-E-02 manifest_sources R2 a missing last frame or a repeated frame number is refused',
  'TEST-E-02 manifest_sources R3 an incomplete or broken page chain is refused',
  'TEST-E-02 manifest_sources R4 an external object without its source, or a source claim that hides the producer, is refused',
  'TEST-E-02 manifest_sources R5 a mammography object without its header, with another object\'s header or with fewer references than its header is refused',
  'TEST-E-02 manifest_sources R6 relabelled origin, a foreign study object, a missing decoder pin or a copied manifest is refused',
  'TEST-E-02 manifest_sources R7 E-R3-01 CP1 header frame count binds the declaration and complete manifest frame set',
  'TEST-E-02 manifest_sources R8 E-R3-02 CP2 source frame claims cannot replace the raw reference inventory',
  'TEST-E-02 manifest_sources R9 E-R3-03 CP3 identical unverified partial regions never approve a source',
  'TEST-E-02 manifest_sources R10 E-R3-04 CP4 contrast energy and unsupported BTO extensions never enter ordinary slots',
  'TEST-E-02 manifest_sources R11 E-R3-05 CP5 duplicate positions are refused even inside spacing tolerance',
  'TEST-E-02 manifest_sources R12 E-R3-06 CP6 conflicting root Frame Type claims remain unverified',
  'TEST-E-02 manifest_sources R13 E-R3-02 CP7 a supplied source class cannot override the stored class claim',
  'TEST-E-02 manifest_sources R14 E-R3-07 CP8 frame counts and lengths are checked before inspecting frame data',
  'TEST-E-02 manifest_sources R15 E-R3-05 CP9 non-finite spacing cannot verify slices',
  'TEST-E-02 manifest_sources R16 D744 malformed partial declarations and sequences are conflicts, never absence',
  'TEST-E-02 manifest_sources A5 D744 declaration and fullness survive hashing and reread; old manifests cannot authorize the changed content',
  'TEST-E-02 manifest_sources A6 D744 complete source headers preserve every raw path through failed verification and recovery',
  'TEST-E-02 manifest_sources R17 E-R4-01 A1 text abc is a rejected frame reference and remains verbatim in the digest',
  'TEST-E-02 manifest_sources R18 E-R4-01 A2 fractional 2.5 is a rejected frame reference and remains verbatim in the digest',
  'TEST-E-02 manifest_sources R19 E-R4-01 A3 text NaN is a rejected frame reference and remains verbatim in the digest',
  'TEST-E-02 manifest_sources R20 E-R4-01 A4 mixed 2 and x is a rejected frame reference and remains verbatim in the digest',
  'TEST-E-02 manifest_sources R21 E-R4-02 unreadable counts cannot be delivered and unsupported readable counts still bind the inventory',
  'TEST-E-02 manifest_sources R22 E-R4-03 a malformed object stays unverified with unresolved sources while normal objects open and hang',
  'TEST-E-02 manifest_sources R23 E-R4-04 non-P format errors preserve Partial View facts and the actual error basis',
  'TEST-E-02 manifest_sources R24 E-R4-05 empty frame selection needs a single-frame target and source SOP class cannot be missing',
  'TEST-E-02 manifest_sources A7 E-R4-01 valid numeric strings retain their raw spelling and the reference inventory must match it',
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
const RULE_TABLE = path.join(__dirname, 'rule-cases.json');
// Shared contract identity, normalized to LF for Git checkouts (AGENTS 1-B.14), not a product implementation pin.
const RULE_TABLE_LF_SHA256 = 'a60b86b6267853615872a915d66a59150062afdbfe5d8725ca7a55f578c984d0';
const ruleBytes = Buffer.from(fs.readFileSync(RULE_TABLE).toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
if (createHash('sha256').update(ruleBytes).digest('hex') !== RULE_TABLE_LF_SHA256) throw new Error('rule-cases.json is not the D744-2 table this file is bound to');
const RULE = JSON.parse(ruleBytes.toString('utf8'));
if (RULE.schemaVersion !== 'D744-2' || RULE.cases.length !== 273 || new Set(RULE.cases.map(c => c.testId)).size !== 273) throw new Error('unexpected D744-2 table shape');
const DECLARED = [...CASES, ...RULE.cases.map(c => c.testId)];
if (process.argv.includes('--list-cases')) {
  process.stdout.write(JSON.stringify(DECLARED) + '\n');
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
/** PS3.18 DICOM JSON element. Headers below are synthetic, shaped like the D735 table's cases. */
const dj = (vr, ...v) => ({ vr, Value: v });
const viewCodeItem = (code = '399162004', meaning = 'cranio-caudal') => ({ '00080100': dj('SH', code), '00080102': dj('SH', 'SCT'), '00080104': dj('LO', meaning) });
function mgHeader(study, series, sop, sopClass, type, laterality, extra = {}) {
  return { '00080016': dj('UI', sopClass), '00080018': dj('UI', sop), '0020000D': dj('UI', study), '0020000E': dj('UI', series), '00080060': dj('CS', 'MG'),
    '00080008': dj('CS', ...type), '00080068': dj('CS', sopClass === SC('1.2.1') ? 'FOR PROCESSING' : 'FOR PRESENTATION'),
    '00200062': dj('CS', laterality), '00540220': dj('SQ', viewCodeItem()), '00281350': dj('CS', 'NO'), ...extra };
}
function btoHeader(study, series, sop, n, type, laterality, { thickness = 1, step = 1, vp = 'VOLUME', tech = 'NONE' } = {}) {
  const hd = mgHeader(study, series, sop, SC('13.1.3'), type, laterality, { '00280008': dj('IS', n), '00089206': dj('CS', vp), '00089207': dj('CS', tech),
    '52009229': dj('SQ', { '00289110': dj('SQ', { '00180050': dj('DS', thickness) }), '00209116': dj('SQ', { '00200037': dj('DS', 1, 0, 0, 0, 1, 0) }) }),
    '52009230': dj('SQ', ...Array.from({ length: n }, (_, k) => ({ '00189504': dj('SQ', { '00089007': dj('CS', ...type), '00089206': dj('CS', vp), '00089207': dj('CS', tech) }),
      '00209113': dj('SQ', { '00200032': dj('DS', 0, 0, k * step) }) }))) });
  delete hd['00080068'];
  return hd;
}
const withHeader = (entry, header) => ({ ...entry, mammography: { header, declaredSources: null, claimedClass: null } });
function studyObjects(study = STUDY) {
  const conventional = ['DERIVED', 'PRIMARY'], dbtType = ['ORIGINAL', 'PRIMARY', 'TOMOSYNTHESIS', 'NONE'], generated = ['DERIVED', 'PRIMARY', 'TOMOSYNTHESIS', 'GENERATED_2D'];
  return [
    pixel(study, S(study, 1), S(study, 1) + '.1', SC('2'), { imageType: ['ORIGINAL', 'PRIMARY', 'AXIAL'] }),
    pixel(study, S(study, 1), S(study, 1) + '.2', SC('2'), { imageType: ['ORIGINAL', 'PRIMARY', 'AXIAL'] }),
    withHeader(pixel(study, S(study, 2), S(study, 2) + '.1', SC('1.2'), { imageType: conventional, derivation: { kind: 'derived', sources: [] } }),
      mgHeader(study, S(study, 2), S(study, 2) + '.1', SC('1.2'), conventional, 'R')),
    withHeader(pixel(study, S(study, 3), S(study, 3) + '.1', SC('13.1.3'), { ts: TS.j2k, frames: 6, imageType: dbtType }),
      btoHeader(study, S(study, 3), S(study, 3) + '.1', 6, dbtType, 'L')),
    withHeader(pixel(study, S(study, 4), S(study, 4) + '.1', SC('1.2'), { imageType: generated,
      derivation: { kind: 'derived', sources: [{ studyUid: study, seriesUid: S(study, 3), sopInstanceUid: S(study, 3) + '.1' }] } }),
      mgHeader(study, S(study, 4), S(study, 4) + '.1', SC('1.2'), generated, 'L', { '00082112': dj('SQ', { '00081150': dj('UI', SC('13.1.3')), '00081155': dj('UI', S(study, 3) + '.1') }) })),
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
    pages, decoderCatalog: opts.catalog ?? CATALOG, viewer: opts.viewer ?? VIEWER, referencedObjects: opts.referencedObjects ?? [] };
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
  assert.deepEqual([byUid[DBT].mammography.class, byUid[SYNTH].mammography.class, byUid[SYNTH].mammography.sourceLinkStatus], ['dbt-slices', 'device-synthetic-2d', 'verified']);
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
  const m = build(), byUid = Object.fromEntries(m.objects.map(o => [o.sopInstanceUid, o]));
  assert.equal(m.classificationRule, 'D744-2');
  const synth = byUid[SYNTH].mammography;
  assert.deepEqual([byUid[DBT].mammography.class, byUid[DBT].mammography.representation, synth.class, synth.fullViewAutoMatch], ['dbt-slices', 'slices', 'device-synthetic-2d', true]);
  // The raw reference is kept with its path and judged against the stored target header.
  assert.deepEqual(synth.links.map(l => [l.path, l.sopClass, l.sop, l.status]), [['SourceImageSequence[0]/', SC('13.1.3'), DBT, 'verified']]);
  // A caller label is recorded and compared, never used: the conventional header stays conventional.
  const claimed = studyObjects(); claimed[2] = { ...claimed[2], mammography: { ...claimed[2].mammography, claimedClass: 'dbt-slices' } };
  const conventional = allowed(() => build(claimed)).objects.find(o => o.sopInstanceUid === S(STUDY, 2) + '.1').mammography;
  assert.deepEqual([conventional.class, conventional.claim], ['conventional-2d-presentation', { class: 'dbt-slices', agrees: false }]);
  // Only the stored header changes (one DBT frame loses its position): the verdict changes, the object stays listed and
  // deliverable, and the manifest is a new version.
  const moved = studyObjects(); const header = structuredClone(moved[3].mammography.header);
  delete header['52009230'].Value[1]['00209113'];
  moved[3] = { ...moved[3], mammography: { ...moved[3].mammography, header } };
  const changed = allowed(() => build(moved)), dbt = changed.objects.find(o => o.sopInstanceUid === DBT);
  assert.deepEqual([dbt.mammography.class, dbt.mammography.representation, dbt.frames.length], ['unverified', 'unspecified', 6]);
  assert.equal(changed.objects.find(o => o.sopInstanceUid === SYNTH).mammography.sourceLinkStatus, 'rejected');
  assert.notEqual(changed.sha256, m.sha256);
  assert.equal(allowed(() => prepare(changed, `/dicom-web/studies/${STUDY}/series/${S(STUDY, 3)}/instances/${DBT}/frames/1`)).units.length, 1);
});
def('TEST-E-02 manifest_sources R5', () => {
  const noHeader = studyObjects(); noHeader[3] = { ...noHeader[3], mammography: null };
  refused(() => build(noHeader), 'MammographyHeaderRequired');
  const otherHeader = studyObjects(); otherHeader[3] = { ...otherHeader[3], mammography: { ...otherHeader[3].mammography, header: studyObjects()[2].mammography.header } };
  refused(() => build(otherHeader), 'MammographyHeaderMismatch');
  const typeDiffers = studyObjects(); typeDiffers[2] = { ...typeDiffers[2], imageType: ['DERIVED', 'PRIMARY', ''] };
  refused(() => build(typeDiffers), 'MammographyHeaderMismatch');
  // An optional reference inventory must match the complete header exactly.
  const fewer = studyObjects(); fewer[4] = { ...fewer[4], mammography: { ...fewer[4].mammography, declaredSources: [] } };
  refused(() => build(fewer), 'MammographyHeaderMismatch');
  const listedTwice = { header: studyObjects()[3].mammography.header, patientKey: PATIENT.linkId, institutionKey: INSTITUTION };
  refused(() => M.buildImageManifest(manifestInput(studyObjects(), { referencedObjects: [listedTwice] })), 'DuplicateObjectConflict');
  refused(() => M.buildImageManifest({ ...manifestInput(), referencedObjects: 'none' }), 'MammographyHeaderInvalid');
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

// R4 counterexamples: REQ-EMR-11/17 -> RISK-E-02 -> TEST-E-02; D744 facts also bind RISK-D744-FALSE-FULL-OR-FRICTION/SOURCE-PROMOTION.
const ruleCase = id => structuredClone(RULE.cases.find(c => c.id === id));
const rawLinks = r => r.links.map(({ path, sopClass, sop, frames }) => ({ path, sopClass, sop, frames }));
def('TEST-E-02 manifest_sources R7', () => {
  const objects = studyObjects(), o = objects.find(o => o.sopInstanceUid === DBT);
  assert.equal(o.mammography.header['00280008'].Value[0], 6);
  o.declaredFrameCount = 1; o.frames = o.frames.slice(0, 1);
  const before = structuredClone(objects);
  refused(() => build(objects), 'MammographyHeaderMismatch');
  assert.deepEqual(objects, before);
  assert.deepEqual(allowed(() => build()).objects.find(o => o.sopInstanceUid === DBT).frames.map(f => f.number), [1, 2, 3, 4, 5, 6]);
});
def('TEST-E-02 manifest_sources R8', () => {
  const c = ruleCase('SOURCE-FRAME-OUT-OF-RANGE'), r = allowed(() => ruleCaseResult(c));
  assert.equal(r.sourceAccepted, false);
  c.input.declaredSources = rawLinks(r); c.input.declaredSources[0].frames = [1];
  const before = structuredClone(c);
  refused(() => ruleCaseResult(c), 'MammographyHeaderMismatch');
  assert.deepEqual(c, before);
  // Each dimension, occurrence and missing/extra reference matters, even if the same SOP remains in the list.
  const valid = ruleCase('SOURCE-FRAME-VALID'), raw = rawLinks(allowed(() => ruleCaseResult(valid)));
  for (const inventory of [[], [...raw, raw[0]], [{ ...raw[0], path: 'SourceImageSequence[1]/' }],
    [{ ...raw[0], sop: '2.25.99999' }], [{ ...raw[0], frames: null }]]) {
    valid.input.declaredSources = inventory;
    refused(() => ruleCaseResult(valid), 'MammographyHeaderMismatch');
  }
  valid.input.declaredSources = raw;
  assert.equal(allowed(() => ruleCaseResult(valid)).sourceAccepted, true);
});
def('TEST-E-02 manifest_sources R9', () => {
  const original = ruleCase('SOURCE-SAME-PARTIAL');
  assert.equal(allowed(() => ruleCaseResult(original)).sourceAccepted, true);
  for (const code of [
    { '00080100': dj('SH', 'UNKNOWN-REGION'), '00080102': dj('SH', '99PRIVATE'), '00080104': dj('LO', 'Medial') },
    { '00080100': dj('SH', '255561001'), '00080102': dj('SH', '99PRIVATE') }, {},
  ]) {
    const c = structuredClone(original);
    for (const hd of [c.input.dicom, ...c.input.context.storedObjects.map(o => o.dicom)]) hd['00281352'] = dj('SQ', structuredClone(code));
    const r = allowed(() => ruleCaseResult(c));
    assert.equal(r.sourceAccepted, false, 'identical unverified regions cannot prove the same partial coverage');
    assert.equal(r.sourceLinkStatus, 'unresolved');
    assert.deepEqual(rawLinks(r), rawLinks(ruleCaseResult(original)));
  }
  // The same verified CID concept may use a legacy code on the target.
  const legacy = structuredClone(original);
  const code = legacy.input.context.storedObjects[0].dicom['00281352'].Value[0];
  code['00080100'] = dj('SH', 'R-404D5'); code['00080102'] = dj('SH', 'SRT');
  assert.equal(allowed(() => ruleCaseResult(legacy)).sourceAccepted, true);
});
def('TEST-E-02 manifest_sources R10', () => {
  assert.equal(allowed(() => ruleCaseResult(ruleCase('DBT-SLICES-SAMPLED'))).fullViewAutoMatch, true);
  for (const value of ['LOW_ENERGY', 'HIGH_ENERGY', 'ADDITION', 'SUBTRACTION', 'UNSUPPORTED']) {
    const c = ruleCase('DBT-SLICES-SAMPLED'), hd = c.input.dicom;
    hd['00080008'].Value.push(value);
    for (const f of hd['52009230'].Value) f['00189504'].Value[0]['00089007'].Value.push(value);
    const r = allowed(() => ruleCaseResult(c));
    assert.deepEqual([r.class, r.status, r.fullViewAutoMatch, r.sourceClassEligible], ['unverified', 'unverified', false, false]);
  }
});
def('TEST-E-02 manifest_sources R11', () => {
  const o = studyObjects().find(o => o.sopInstanceUid === DBT), hd = o.mammography.header;
  hd['52009229'].Value[0]['00289110'].Value[0]['00180050'].Value = [0.01];
  const zs = [0, 0, 0.01, 0.02, 0.03, 0.04];
  hd['52009230'].Value.forEach((f, i) => { f['00209113'].Value[0]['00200032'].Value = [0, 0, zs[i]]; });
  assert.equal(allowed(() => build([o])).objects[0].mammography.status, 'unverified');
  hd['52009230'].Value.forEach((f, i) => { f['00209113'].Value[0]['00200032'].Value = [0, 0, i * 0.01]; });
  assert.equal(allowed(() => build([o])).objects[0].mammography.class, 'dbt-slices');
});
def('TEST-E-02 manifest_sources R12', () => {
  const o = studyObjects().find(o => o.sopClassUid === SC('1.2'));
  o.mammography.header['00089007'] = dj('CS', 'DERIVED', 'PRIMARY', 'TOMOSYNTHESIS', 'GENERATED_2D');
  const before = structuredClone(o), r = allowed(() => build([o])).objects[0].mammography;
  assert.deepEqual([r.class, r.fullViewAutoMatch], ['unverified', false]);
  assert.deepEqual(o, before);
  delete o.mammography.header['00089007'];
  assert.equal(allowed(() => build([o])).objects[0].mammography.class, 'conventional-2d-presentation');
  const c = ruleCase('DBT-SLICES-SAMPLED'); c.input.dicom['00089007'] = dj('CS', 'ORIGINAL', 'PRIMARY', 'TOMO_PROJ', 'NONE');
  assert.equal(allowed(() => ruleCaseResult(c)).status, 'unverified');
});
def('TEST-E-02 manifest_sources R13', () => {
  const c = ruleCase('SOURCE-UID-CLASS-CONFLICT'), r = allowed(() => ruleCaseResult(c));
  assert.equal(r.sourceAccepted, false);
  c.input.declaredSources = rawLinks(r);
  c.input.declaredSources[0].sopClass = c.input.context.storedObjects[0].dicom['00080016'].Value[0];
  refused(() => ruleCaseResult(c), 'MammographyHeaderMismatch');
  c.input.declaredSources = rawLinks(r);
  assert.deepEqual(rawLinks(allowed(() => ruleCaseResult(c))), rawLinks(r));
  assert.equal(ruleCaseResult(c).sourceAccepted, false);
});
def('TEST-E-02 manifest_sources R14', () => {
  for (const [count, length, reason] of [[2001, 2001, 'frame-count-range'], [6, 2001, 'frame-count-range'], [6, 5, 'per-frame-count']]) {
    const hd = studyObjects().find(o => o.sopInstanceUid === DBT).mammography.header;
    hd['00280008'].Value = [count];
    let inspected = 0;
    hd['52009230'].Value = Array.from({ length }, () => Object.defineProperty({}, '00209071', {
      get() { inspected++; return dj('SQ', { '00209072': dj('CS', 'L') }); },
    }));
    const r = allowed(() => M.classifyMammography(hd));
    assert.equal(r.result.status, 'unverified');
    assert.equal(r.result.basis, reason);
    assert.equal(inspected, 0, 'refused frame arrays must not inspect frame anatomy');
  }
  // Manifest array length is also checked before reading even its first frame digest.
  const o = studyObjects().find(o => o.sopInstanceUid === DBT); let inspected = 0;
  o.frames = Array.from({ length: 5 }, () => Object.defineProperty({ bytes: 10, sha256: h('frame') }, 'number', {
    enumerable: true, get() { inspected++; return 1; },
  }));
  refused(() => build([o]), 'FrameSetIncomplete');
  assert.equal(inspected, 0);
});
def('TEST-E-02 manifest_sources R15', () => {
  const o = studyObjects().find(o => o.sopInstanceUid === DBT), pm = o.mammography.header['52009229'].Value[0]['00289110'].Value[0];
  for (const v of ['NaN', 'Infinity', '-Infinity', Number.NaN]) {
    pm['00180088'] = dj('DS', v);
    assert.equal(allowed(() => build([o])).objects[0].mammography.status, 'unverified', 'non-finite spacing is not a verified slice interval');
  }
  pm['00180088'] = dj('DS', '1');
  assert.equal(allowed(() => build([o])).objects[0].mammography.class, 'dbt-slices');
});
def('TEST-E-02 manifest_sources R16', () => {
  const base = ruleCase('PARTIAL-ABSENT');
  for (const element of [null, [], 17, { vr: 'CS', Value: 'NO' }, { vr: 'PN', Value: ['NO'] }]) {
    const c = structuredClone(base); c.input.dicom['00281350'] = element;
    const r = allowed(() => ruleCaseResult(c));
    assert.deepEqual([r.partialDeclaration, r.partial, r.fullness, r.fullViewAutoMatch], ['INVALID', 'conflict', 'conflict', false]);
  }
  for (const element of [null, [], { vr: 'SQ', Value: {} }, { vr: 'CS', Value: [] }]) {
    const c = structuredClone(base); c.input.dicom['00281352'] = element;
    const r = allowed(() => ruleCaseResult(c));
    assert.deepEqual([r.partialDeclaration, r.partial, r.fullness, r.fullViewAutoMatch], ['ABSENT', 'conflict', 'conflict', false]);
  }
});
def('TEST-E-02 manifest_sources A5', () => {
  const original = studyObjects();
  for (const o of original) if (o.mammography) delete o.mammography.header['00281350'];
  const absent = allowed(() => build(original)), r = absent.objects.find(o => o.sopInstanceUid === SYNTH).mammography;
  assert.deepEqual([absent.classificationRule, r.rule, r.partialDeclaration, r.partial, r.fullness, r.fullViewAutoMatch],
    ['D744-2', 'D744-2', 'ABSENT', 'unknown', 'inferred-for-hanging', true]);
  assert.equal(r.sourceAccepted, false, 'automatic hanging does not prove source coverage');
  const again = allowed(() => M.buildImageManifest({ ...manifestInput(structuredClone(original)), builtAt: T2 }));
  assert.equal(again.sha256, absent.sha256); assert.deepEqual(again.objects, absent.objects);
  const emptyInput = structuredClone(original);
  emptyInput.find(o => o.sopInstanceUid === SYNTH).mammography.header['00281350'] = dj('CS', '');
  const empty = allowed(() => build(emptyInput));
  assert.notEqual(empty.sha256, absent.sha256, 'ABSENT versus EMPTY alone changes the declaration content digest');
  const no = allowed(() => build());
  assert.notEqual(no.sha256, absent.sha256);
  const noResult = no.objects.find(o => o.sopInstanceUid === SYNTH).mammography;
  assert.deepEqual([noResult.partialDeclaration, noResult.fullness, noResult.fullViewAutoMatch], ['NO', 'declared-not-partial', true]);
  for (const tags of [
    { '00281350': dj('CS', 'YES') },
    { '00281352': dj('SQ', { '00080100': dj('SH', '255561001'), '00080102': dj('SH', 'SCT') }) },
    { '00281351': dj('LO', 'full view') },
    { '00281350': dj('CS', 'NO'), '00281351': dj('LO', 'partial') },
  ]) {
    const input = structuredClone(original); Object.assign(input.find(o => o.sopInstanceUid === SYNTH).mammography.header, tags);
    const changed = allowed(() => build(input));
    assert.notEqual(changed.sha256, absent.sha256);
    assert.equal(changed.objects.find(o => o.sopInstanceUid === SYNTH).mammography.fullViewAutoMatch, false);
    refused(() => E.classifyDisplayReport(openingFor(changed), changed, report(absent), viewing(absent)), 'ManifestVersionMismatch');
  }
  const old = structuredClone(absent); old.classificationRule = 'D735-1';
  refused(() => prepare(old, `/dicom-web/studies/${STUDY}`), 'ManifestRequired');
});
def('TEST-E-02 manifest_sources A6', () => {
  for (const id of ['PUBLIC-010', 'PUBLIC-011', 'PUBLIC-012', 'PUBLIC-013']) {
    const c = ruleCase(id); assert.equal(c.input.declaredSources, undefined);
    const r = allowed(() => ruleCaseResult(c));
    assert.equal(r.declaredSourceCount, 10);
    assert.deepEqual(rawLinks(r), c.source.raw_reference_inventory, 'complete headers retain all acquisition and derivation paths');
    c.input.declaredSources = [...c.source.raw_reference_inventory].reverse();
    assert.deepEqual(rawLinks(allowed(() => ruleCaseResult(c))), rawLinks(r), 'inventory order cannot reorder the raw references');
  }
  for (const id of ['V2-049', 'V2-050']) assert.equal(allowed(() => ruleCaseResult(ruleCase(id))).declaredSourceCount, 1);
  const c = ruleCase('SOURCE-FRAME-VALID'), original = structuredClone(c), verified = allowed(() => ruleCaseResult(c));
  delete c.input.context.storedObjects[0].dicom['52009230'].Value[0]['00209113'];
  const rejected = allowed(() => ruleCaseResult(c));
  assert.equal(rejected.sourceAccepted, false); assert.deepEqual(rawLinks(rejected), rawLinks(verified));
  assert.deepEqual(allowed(() => ruleCaseResult(original)), verified, 'reread after restoring the header recovers without changing the raw source');
});

// Round 5 review cases exercise the public manifest and delivery boundaries, including raw-value preservation.
for (const [id, frames] of [[17, ['abc']], [18, [2.5]], [19, ['NaN']], [20, [2, 'x']]]) {
  def(`TEST-E-02 manifest_sources R${id}`, () => {
    const c = ruleCase('SOURCE-FRAME-VALID');
    c.input.dicom['00082112'].Value[0]['00081160'] = dj('IS', ...frames);
    const before = structuredClone(c), m = allowed(() => ruleCaseManifest(c));
    const r = m.objects.find(o => o.sopInstanceUid === c.input.dicom['00080018'].Value[0]).mammography;
    assert.deepEqual([r.sourceAccepted, r.sourceLinkStatus, r.links[0].status], [false, 'rejected', 'rejected']);
    assert.deepEqual(r.links[0].frames, frames);
    assert.deepEqual(JSON.parse(JSON.stringify(r)).links[0].frames, frames, 'invalid references must survive serialization verbatim');
    assert.deepEqual(c, before, 'classification cannot rewrite the stored input');
    assert.equal(allowed(() => ruleCaseManifest(structuredClone(c))).sha256, m.sha256);
    c.input.dicom['00082112'].Value[0]['00081160'] = dj('IS', null);
    assert.notEqual(allowed(() => ruleCaseManifest(c)).sha256, m.sha256, 'invalid raw frames must not collapse to null in the digest');
    c.input.dicom['00082112'].Value[0]['00081160'] = dj('IS', 2);
    assert.equal(allowed(() => ruleCaseResult(c)).sourceAccepted, true, 'a valid reread recovers the source');
    assert.deepEqual(r.links[0].frames, frames, 'a later input change cannot change the fixed manifest');
  });
}

def('TEST-E-02 manifest_sources A7', () => {
  const c = ruleCase('SOURCE-FRAME-VALID');
  c.input.dicom['00082112'].Value[0]['00081160'] = dj('IS', '  +02 ');
  const m = allowed(() => ruleCaseManifest(c)), r = allowed(() => ruleCaseResult(c));
  assert.equal(r.sourceAccepted, true); assert.deepEqual(r.links[0].frames, ['  +02 ']);
  c.input.declaredSources = rawLinks(r);
  assert.equal(allowed(() => ruleCaseManifest(c)).sha256, m.sha256);
  c.input.declaredSources[0].frames = [2];
  refused(() => ruleCaseManifest(c), 'MammographyHeaderMismatch');
  c.input.declaredSources = null;
  c.input.dicom['00082112'].Value[0]['00081160'] = dj('IS', 2);
  assert.equal(allowed(() => ruleCaseResult(c)).sourceAccepted, true);
  assert.notEqual(allowed(() => ruleCaseManifest(c)).sha256, m.sha256, 'numeric equality must not erase raw source evidence');
});

def('TEST-E-02 manifest_sources R21', () => {
  const all = studyObjects(), o = all.find(o => o.sopInstanceUid === DBT), hd = o.mammography.header;
  o.declaredFrameCount = 1; o.frames = o.frames.slice(0, 1);
  hd['00280008'] = dj('IS', 2001);
  refused(() => build(all), 'MammographyHeaderMismatch');
  for (const values of [[6, 6], [0], [-1], ['abc'], [2.5], ['NaN'], []]) {
    hd['00280008'] = dj('IS', ...values);
    const before = structuredClone(all), m = allowed(() => build(all)), bad = m.objects.find(x => x.sopInstanceUid === DBT);
    assert.deepEqual([bad.unsupported, bad.mammography.status], ['MammographyFrameCountUnreadable', 'unverified']);
    bodyNeverStarts(spy => serve(spy, m, 'GET', `/dicom-web/studies/${STUDY}/series/${o.seriesUid}/instances/${DBT}`), 'MammographyFrameCountUnreadable');
    const whole = allowed(() => prepare(m, `/dicom-web/studies/${STUDY}`));
    assert.equal(whole.units.some(u => u.sopInstanceUid === DBT), false);
    assert.deepEqual(whole.excluded, [{ sopInstanceUid: DBT, reason: 'MammographyFrameCountUnreadable' }]);
    assert.equal(whole.units.length, all.length - 1);
    assert.deepEqual(all, before);
  }
  assert.equal(build().objects.find(x => x.sopInstanceUid === DBT).unsupported, null);
});

def('TEST-E-02 manifest_sources R22', () => {
  const baseline = build();
  for (const flaw of ['2001-frames', 'source-uid', 'source-uid-absent-partial', 'root-sequence', 'acquisition-sequence', 'derivation-sequence', 'per-frame-source']) {
    const all = studyObjects(), uid = flaw === '2001-frames' ? DBT : SYNTH, o = all.find(x => x.sopInstanceUid === uid), hd = o.mammography.header;
    if (flaw === '2001-frames') {
      hd['00280008'] = dj('IS', 2001);
      hd['52009230'].Value = Array.from({ length: 2001 }, () => structuredClone(hd['52009230'].Value[0]));
      o.declaredFrameCount = 2001; o.frames = frameSet(uid, 2001, 1); o.bytes = 6000;
    } else if (flaw.startsWith('source-uid')) {
      hd['00082112'].Value[0]['00081155'] = dj('UI', { bad: true });
      if (flaw === 'source-uid-absent-partial') delete hd['00281350'];
    }
    else if (flaw === 'root-sequence') hd['00082112'] = { vr: 'SQ', Value: {} };
    else if (flaw === 'acquisition-sequence') hd['00189507'] = dj('SQ', { '00082112': dj('SQ', null) });
    else if (flaw === 'derivation-sequence') hd['00089124'] = dj('SQ', { '00082112': { vr: 'CS', Value: [] } });
    else hd['52009230'] = dj('SQ', { '00089124': dj('SQ', { '00082112': dj('SQ', null) }) });
    const before = structuredClone(all), m = allowed(() => build(all)), bad = m.objects.find(x => x.sopInstanceUid === uid).mammography;
    assert.equal(m.objects.length, baseline.objects.length, flaw);
    assert.deepEqual([bad.class, bad.status, bad.fullViewAutoMatch, bad.sourceAccepted, bad.sourceLinkStatus],
      ['unverified', 'unverified', false, false, 'unresolved'], flaw);
    assert.equal(bad.declaredSourceCount, null, 'failed extraction cannot report a known empty source inventory');
    assert.equal(bad.fullness, flaw === 'source-uid-absent-partial' ? 'undetermined' : 'declared-not-partial');
    assert.deepEqual(bad.sourceHeader, hd, 'unreadable source evidence stays available without inventing an inventory');
    const normal = m.objects.find(x => x.sopInstanceUid === S(STUDY, 2) + '.1');
    assert.deepEqual(normal, baseline.objects.find(x => x.sopInstanceUid === normal.sopInstanceUid));
    assert.equal(normal.mammography.status, 'verified'); assert.equal(normal.mammography.fullViewAutoMatch, true);
    assert.equal(allowed(() => prepare(m, `/dicom-web/studies/${STUDY}`)).units.length, all.length);
    assert.deepEqual(all, before);
    assert.equal(allowed(() => build(structuredClone(all))).sha256, m.sha256);
    hd['00082112'] = dj('SQ', { '00081155': dj('UI', { different: true }) });
    assert.notEqual(allowed(() => build(all)).sha256, m.sha256, 'retained malformed evidence is manifest content');
  }
  assert.equal(build().sha256, baseline.sha256, 'reread of repaired objects restores normal behaviour');
});

def('TEST-E-02 manifest_sources R23', () => {
  for (const [flag, partial, fullness] of [['NO', 'no', 'declared-not-partial'], ['YES', 'yes', 'partial'], [null, 'unknown', 'undetermined']]) {
    for (const tag of ['00200062', '00185101', '00540220']) {
      const c = ruleCase('SOURCE-FRAME-VALID');
      if (flag) c.input.dicom['00281350'] = dj('CS', flag); else delete c.input.dicom['00281350'];
      c.input.dicom[tag] = tag === '00540220' ? { vr: 'SQ', Value: {} } : dj('CS', {});
      const r = allowed(() => ruleCaseResult(c));
      assert.deepEqual([r.status, r.partial, r.fullness, r.fullViewAutoMatch], ['unverified', partial, fullness, false]);
      assert.equal(r.basis, tag === '00540220' ? 'partial-sequence-malformed' : `malformed-${tag}`);
    }
  }
  const c = ruleCase('SOURCE-FRAME-VALID');
  c.input.dicom['00200062'] = dj('CS', {});
  c.input.dicom['00281350'] = dj('CS', 'NO'); c.input.dicom['00281351'] = dj('LO', 'partial');
  const conflict = allowed(() => ruleCaseResult(c));
  assert.deepEqual([conflict.partial, conflict.fullness], ['conflict', 'conflict'], 'a real P contradiction still survives unrelated errors');
});

def('TEST-E-02 manifest_sources R24', () => {
  const c = ruleCase('SOURCE-FRAME-VALID'), ref = c.input.dicom['00082112'].Value[0];
  for (const e of [dj('IS'), { vr: 'IS' }]) {
    ref['00081160'] = e;
    const r = allowed(() => ruleCaseResult(c));
    assert.deepEqual([r.sourceAccepted, r.sourceLinkStatus, r.links[0].frames], [false, 'unresolved', []]);
  }
  delete ref['00081160'];
  assert.equal(allowed(() => ruleCaseResult(c)).sourceAccepted, true, 'an absent selection still names the whole object');
  const target = c.input.context.storedObjects[0].dicom;
  const type = ['DERIVED', 'PRIMARY', 'TOMO_PROJ', 'NONE'];
  target['00080008'] = dj('CS', ...type); target['00280008'] = dj('IS', 1);
  target['52009230'].Value = target['52009230'].Value.slice(0, 1);
  target['52009230'].Value[0]['00189504'].Value[0]['00089007'] = dj('CS', ...type);
  ref['00081160'] = dj('IS');
  const single = allowed(() => ruleCaseResult(c));
  assert.deepEqual([single.sourceAccepted, single.links[0].frames], [true, []]);
  for (const frames of [[], [1]]) {
    ref['00081160'] = dj('IS', ...frames); delete ref['00081150'];
    const r = allowed(() => ruleCaseResult(c));
    assert.deepEqual([r.sourceAccepted, r.sourceLinkStatus, r.links[0].sopClass], [false, 'unresolved', null]);
  }
});

// ── TEST-D735-* / TEST-D744-* shared mammography table, through the manifest path ────────────────────────────────────
/** Moves tags into the manifest's object input: identity, the stored frame count, Image Type and its Value 1, synthetic
 * byte digests. Classification facts are left to the manifest; the case's expected values are never read here. */
function entryFromHeader(hd, declaredSources, claimedClass) {
  const value = tag => hd[tag]?.Value ?? null;
  const perFrame = value('52009230'), nf = value('00280008')?.[0];
  // Include the just-over-budget 2001-frame object. The billion-frame resource case instead checks refusal plus
  // header classification below; its small inventory must never silently stand in for the declared billion frames.
  const count = Number(nf);
  const n = Number.isInteger(count) && count > 0 && count <= 2001 ? count : perFrame?.length || 1;
  const imageType = hd['00080008'] === undefined ? null : [...(hd['00080008'].Value ?? [])];
  const v1 = typeof imageType?.[0] === 'string' ? imageType[0].trim() : null, sop = value('00080018')[0];
  return { studyUid: value('0020000D')[0], seriesUid: value('0020000E')[0], sopInstanceUid: sop, sopClassUid: value('00080016')[0],
    transferSyntaxUid: TS.explicit, imageType, bytes: n * 10 + 100, sha256: h(sop), declaredFrameCount: n, frames: frameSet(sop, n, 10),
    provenance: { kind: 'device', receiptEventId: `rcpt-${sop}` },
    derivation: v1 === 'ORIGINAL' ? { kind: 'original' } : v1 === 'DERIVED' ? { kind: 'derived', sources: [] } : { kind: 'unknown' },
    mammography: { header: hd, declaredSources, claimedClass }, timing: null };
}
/** Stored objects of the same study, patient and institution are listed objects; any other stored object is an
 * out-of-study reference target with the keys it was resolved under (ManifestInput.referencedObjects). */
function ruleCaseManifest(c) {
  const ctx = c.input.context ?? null, patientKey = ctx?.patientKey ?? 'synthetic-patient', institutionKey = ctx?.institutionKey ?? 'synthetic-institution';
  const study = c.input.dicom['0020000D'].Value[0];
  const objects = [entryFromHeader(c.input.dicom, c.input.declaredSources ?? null, null)], referencedObjects = [];
  for (const s of ctx?.storedObjects ?? []) {
    if (s.dicom['0020000D'].Value[0] === study && s.patientKey === patientKey && s.institutionKey === institutionKey)
      objects.push(entryFromHeader(s.dicom, null, ctx.claimedSourceClass ?? null));
    else referencedObjects.push({ header: s.dicom, patientKey: s.patientKey, institutionKey: s.institutionKey });
  }
  const m = M.buildImageManifest({ formatVersion: 1, studyUid: study, managingInstitution: institutionKey, builtAt: T0,
    patient: { linkId: patientKey, patientId: 'SYN-D735', assigningAuthority: 'synthetic-authority' },
    expected: { series: new Set(objects.map(o => o.seriesUid)).size, objects: objects.length }, pages: [{ cursor: null, next: null, objects }],
    decoderCatalog: CATALOG, viewer: VIEWER, referencedObjects });
  return m;
}
function ruleCaseResult(c) {
  return ruleCaseManifest(c).objects.find(o => o.sopInstanceUid === c.input.dicom['00080018'].Value[0]).mammography;
}
for (const c of RULE.cases) {
  registered.add(c.testId);
  test(c.testId, () => {
    let result;
    if (Number(c.input.dicom['00280008']?.Value?.[0]) > 2001) {
      refused(() => ruleCaseManifest(c), 'MammographyHeaderMismatch');
      result = allowed(() => M.classifyMammography(c.input.dicom)).result;
    } else result = ruleCaseResult(c);
    for (const [key, expected] of Object.entries(c.expected)) assert.deepEqual(result[key], expected, `${c.id}: ${key}`);
  });
}

// Every declared case has exactly one body and nothing undeclared runs; a mismatch stops the file before any case starts.
assert.deepEqual([...registered].sort(), [...DECLARED].sort());
