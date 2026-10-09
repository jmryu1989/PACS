/* EMR-H round 1 contract tests (pure planning/verification; no storage, deletion or network).
 * REQ-EMR-17 -> RISK-H-01 -> TEST-H-01/period_extension      REQ-EMR-03/17 -> RISK-H-02 -> TEST-H-02/archive_and_holds
 * REQ-EMR-01/17 -> RISK-H-03 -> TEST-H-03/inventory_refusal  REQ-EMR-06/17 -> RISK-H-04 -> TEST-H-04/expired_restore_impossible
 * REQ-EMR-05/17 -> RISK-H-05 -> TEST-H-05/key_lifetime       REQ-EMR-17 -> RISK-H-06 -> TEST-H-06/crash_resume
 * REQ-EMR-19 -> RISK-H-07 -> TEST-H-07/facility_processor
 * D73: every assertion is on a behaviour pair (allowed outcome / refusal code with zero started records and zero
 * deletion calls, or the verification status) and on contract fields; no implementation string, internal name or
 * byte pin. Periods are taken from A (retentionDeadline/civilPeriodEnd) so the calendar rule has one owner.
 * KIN_EMR_RETENTION_SRC points at a copy of api/src (emr-contract + emr-retention) for tests/emr/h/mutants.py.
 * Synthetic data only.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { test: nodeTest, beforeEach } = require('node:test');
const declaredCases = [];
function test(name, body) {
  assert(!declaredCases.includes(name), 'case names must be unique');
  declaredCases.push(name);
  if (!process.env.KIN_EMR_H_LIST_CASES) nodeTest(name, body);
}

const root = path.resolve(__dirname, '..', '..', '..');
const api = path.join(root, 'api');
const src = process.env.KIN_EMR_RETENTION_SRC ? path.resolve(process.env.KIN_EMR_RETENTION_SRC) : path.join(api, 'src');
const ts = require(path.join(api, 'node_modules/typescript'));
const config = ts.readConfigFile(path.join(api, 'tsconfig.json'), ts.sys.readFile);
assert.equal(config.error, undefined);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, api);
// Kept for the whole (dedicated) test process: A's composition loads its access mapping lazily at first use.
require.extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'),
  { compilerOptions: parsed.options, fileName: filename }).outputText, filename);
const M = require(path.join(src, 'emr-contract/composition.ts'));
const C = require(path.join(src, 'emr-contract/classification.ts'));
const D = require(path.join(src, 'emr-contract/lawful-defaults.ts'));
const A = require(path.join(src, 'emr-contract/access-event.ts'));
const L = require(path.join(src, 'emr-contract/report-lifecycle.ts'));
const K = require(path.join(src, 'emr-retention/contract.ts'));
const H = require(path.join(src, 'emr-retention/inventory.ts'));

const clone = value => structuredClone(value);
const t0 = '2026-10-05T00:00:00.000Z';
const DAY = 86_400_000;
const shift = (at, ms) => new Date(Date.parse(at) + ms).toISOString();
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
const known = value => ({ status: 'known', value });
const na = { status: 'not-applicable', reason: 'non-record-target' };
const identity = id => ({ id, issuer: 'https://identity.example.test', subject: `sub-${id}` });
const patient = { linkId: 'link-1', patientId: 'SYN-PATIENT-1', assigningAuthority: 'hospital-a' };

// ---- A's server composition with synthetic storage (one per process, as in production) ----
const storedRows = new Map(), dutyRows = new Map(), requestRows = new Map(), correctionRows = new Map(), holdIndex = new Map();
const capabilities = M.composeEmrAdapters({
  stored: { load: (id, eid) => storedRows.get(id + ':' + eid) },
  legal: { load: id => dutyRows.get(id), listHolds: id => ({ recordId: id, holdIds: holdIndex.get(id) || [], complete: true }),
    loadAccessRequest: id => requestRows.get(id), loadCorrectionRequest: id => correctionRows.get(id),
    loadClauseVersions: key => key === 'synthetic-law:article-1' ? [{ law: 'synthetic-law', article: 'article-1', publication: '2026-v1', publishedAt: '2026-01-01', effectiveAt: '2026-01-01' }] : [] },
  purpose: { load: () => undefined, loadSignedResult: () => undefined },
  clinical: { loadStudy: studyId => ({ studyId, patientId: 'SYN-PATIENT-1', assigningAuthority: 'hospital-a', createdAt: t0 }),
    loadReportPatient: recordId => ({ recordId, patientId: 'SYN-PATIENT-1', assigningAuthority: 'hospital-a' }) },
});
const fixtureModels = { image: ['DicomInstance', { sopClass: 'image' }], 'report-version': ['ReportVersion', {}], 'critical-result': ['CriticalResult', {}] };
function stored(kind, recordId, partId, at, options = {}) {
  const [model, row] = fixtureModels[kind];
  const signed = C.RECORD_CLASSIFICATION[kind].signature.rule === 'required';
  const hash = digest(recordId + ':' + partId);
  const event = { eventId: 'event:' + recordId + ':' + partId, recordId, versionId: partId, sha256: hash, contentSha256: hash, at,
    act: signed ? 'entry' : kind === 'image' ? 'acquisition' : 'creation',
    signature: signed ? { versionId: partId, sha256: hash, signedAt: at, verified: true } : null,
    predecessor: null, components: [], processing: null, ...options.event };
  const facts = { recordId, model, row: { ...row }, event };
  storedRows.set(recordId + ':' + event.eventId, facts);
  return C.resolveStoredRecord(capabilities.stored, recordId, event.eventId);
}
const fixtureRecords = new Map();
function remember(record) { fixtureRecords.set(record.recordId, record); holdIndex.set(record.recordId, record.holds.map(h => h.holdId)); return record; }
const component = (record, index = 0) => ({ recordId: record.recordId, partId: record.parts[index].partId, sha256: record.parts[index].evidence.event.sha256 });
const graphOf = (records, references, checkedAt) => ({ records, references, complete: true, revision: 'revision-' + checkedAt, checkedAt });
function snapshotFor(records, at, navigation = []) {
  const all = new Map(records.map(r => [r.recordId, r]));
  for (const unit of [...all.values()]) for (const part of unit.parts) for (const c of part.evidence.event.components)
    if (!all.has(c.recordId) && fixtureRecords.has(c.recordId)) all.set(c.recordId, fixtureRecords.get(c.recordId));
  const references = [...all.values()].flatMap(r => r.parts.flatMap(p => p.evidence.event.components.map(c => ({
    fromRecordId: r.recordId, fromPartId: p.partId, toRecordId: c.recordId, toPartId: c.partId, relation: 'incorporation' }))));
  return graphOf([...all.values()], [...references, ...navigation], at);
}
function makeRecord(recordId, kind, at, partId = recordId + '-1', options = {}) {
  const source = stored(kind, recordId, partId, at, options);
  const deps = source.event.components.map(c => fixtureRecords.get(c.recordId));
  return remember(D.newRetentionRecord(source, deps.length ? snapshotFor(deps, at) : undefined));
}
function addPart(record, partId, at, options = {}, graph) {
  const previous = record.parts[record.parts.length - 1];
  const source = stored(record.kinds[0], record.recordId, partId, at, { ...options, event: {
    predecessor: { recordId: record.recordId, partId: previous.partId, sha256: previous.evidence.event.sha256 }, ...options.event } });
  return remember(D.recordVersionAdded(record, source, graph ?? snapshotFor([record], at)));
}
const holdFacts = (recordId, overrides = {}) => ({ holdId: 'order-' + recordId, recordId, actorId: 'custodian', at: t0, release: null,
  basis: { type: 'court-order', clause: { law: 'synthetic-law', article: 'article-1', version: '2026-v1' }, clauseId: 'synthetic-law:article-1',
    authorityKind: 'court', managingInstitutionId: 'hospital-a', requestId: 'verified-order-42', authorityId: 'court-1', scope: [recordId],
    verified: true, validity: { from: t0, until: null, condition: 'order-in-force' } }, ...overrides });
const dutyReader = facts => { dutyRows.set(facts.holdId, facts); return capabilities.legal; };
const holdRecord = (record, facts) => remember(D.placeLegalHold(record, dutyReader(facts), facts.holdId, snapshotFor([record], facts.at)));
const releaseFacts = (hold, at, overrides = {}) => ({ ...hold, release: { holdId: hold.holdId, actorId: 'custodian', at,
  evidenceId: 'release-99', authorityVerified: true, reason: 'order-ended', ...overrides } });
function pendingHold(recordId, at, until) {
  const h = holdFacts(recordId, { at, holdId: 'request-hold:' + recordId });
  h.basis = { ...h.basis, type: 'pending-access-request', clauseId: 'privacy:35.3', clause: { law: 'privacy', article: '35.3', version: '21445' },
    authorityId: 'hospital-a', authorityKind: 'personal-information-controller', requestId: 'access:' + recordId,
    validity: { from: at, until, condition: 'request-pending' } };
  requestRows.set(h.basis.requestId, { requestId: h.basis.requestId, recordIds: [recordId], receivedAt: at, responseDueAt: until, resolution: null });
  return h;
}
function access(overrides = {}) {
  return { formatVersion: 1, surface: 'GET studies/:uid/report/versions', eventId: 'event-1', userId: known(identity('reader-1')),
    rolesAtTime: known(['radiologist']), actingInstitution: known('hospital-a'), managingInstitution: known('hospital-a'), occurredAt: t0,
    trustedProxyIp: known({ address: '192.0.2.1', source: 'trusted-proxy' }), cause: 'user-view', executor: 'member',
    targets: [{ kind: 'report-version', patientLinkSnapshot: known(patient), studyId: known('study-1'), recordId: known('report-1'), versionId: known('version-1') }],
    action: 'provide-prepared', result: 'prepared', requestId: 'request-1', auditLinkId: A.newAuditLinkId(), relatedEventId: null, ...overrides };
}
const changeEvent = (eventId, at, recordIds) => access({ eventId, occurredAt: at, surface: 'POST studies/:uid/report/commit', action: 'approve-sign', result: 'succeeded',
  targets: recordIds.map(id => ({ kind: 'report-version', patientLinkSnapshot: known(patient), studyId: known('study-1'), recordId: known(id), versionId: known(id + '-1') })) });
const permissionEvent = (eventId, at) => access({ eventId, occurredAt: at, surface: 'POST admin/users/:id/study-access', action: 'modify', result: 'succeeded',
  rolesAtTime: known(['admin']), targets: [{ kind: 'identity-access', patientLinkSnapshot: na, studyId: na, recordId: known('member-7'), versionId: na }] });

// ---- H's composition: a synthetic storage world behind the location reader ----
const CONTENTS_ALL = ['record-part', 'signature-payload', 'derived-copy', 'reference-entry', 'source-mapping', 'identity-evidence', 'access-entry'];
const REGISTRY = { formatVersion: 1, locations: [
  { locationId: 'db', locationClass: 'primary-database', country: 'KR', contents: ['record-part', 'signature-payload', 'reference-entry', 'source-mapping', 'identity-evidence'], deletion: 'per-object', facilityEvidenceId: 'facility-evidence-1' },
  { locationId: 'replica', locationClass: 'database-replica', country: 'KR', contents: ['record-part', 'signature-payload', 'reference-entry', 'source-mapping', 'identity-evidence'], deletion: 'per-object', facilityEvidenceId: 'facility-evidence-1' },
  { locationId: 'orthanc', locationClass: 'image-store', country: 'KR', contents: ['record-part', 'derived-copy'], deletion: 'per-object', facilityEvidenceId: 'facility-evidence-1' },
  { locationId: 'cache', locationClass: 'derivative-cache', country: 'KR', contents: ['derived-copy'], deletion: 'per-object', facilityEvidenceId: 'facility-evidence-1' },
  { locationId: 'ledger', locationClass: 'access-ledger', country: 'KR', contents: ['record-part', 'access-entry'], deletion: 'per-object', facilityEvidenceId: 'facility-evidence-1' },
  { locationId: 'backup', locationClass: 'backup-snapshot', country: 'KR', contents: CONTENTS_ALL, deletion: 'per-container', facilityEvidenceId: 'facility-evidence-1' },
  { locationId: 'offsite', locationClass: 'offsite-backup', country: 'KR', contents: CONTENTS_ALL, deletion: 'per-container', facilityEvidenceId: null },
  { locationId: 'keys', locationClass: 'key-store', country: 'KR', contents: ['key-material'], deletion: 'per-object', facilityEvidenceId: 'facility-evidence-1' },
  { locationId: 'keybackup', locationClass: 'key-backup', country: 'KR', contents: ['key-material'], deletion: 'per-object', facilityEvidenceId: null },
  { locationId: 'terminals', locationClass: 'terminal-store', country: 'KR', contents: ['derived-copy', 'pending-original'], deletion: 'per-object', facilityEvidenceId: null },
  { locationId: 'worm', locationClass: 'removable-media', country: 'KR', contents: CONTENTS_ALL, deletion: 'none', facilityEvidenceId: null },
  ...['database-wal-archive', 'database-snapshot', 'object-store-version', 'export-archive', 'staging', 'crash-dump'].map(locationClass => ({
    locationId: locationClass, locationClass, country: 'KR', contents: CONTENTS_ALL, deletion: 'per-object', facilityEvidenceId: 'facility-evidence-1' })),
] };
const LOCATION_IDS = REGISTRY.locations.map(l => l.locationId);
let world;
function resetWorld() {
  world = { copies: new Map(LOCATION_IDS.map(id => [id, []])), containers: new Map(LOCATION_IDS.map(id => [id, []])), events: new Map(),
    discovered: null, discoveryFails: false, failing: new Set(), incomplete: new Set(), stale: new Set(), unattributed: new Map(), listings: 0 };
}
resetWorld();
const intersects = (a, b) => a.some(x => b.includes(x));
function names(copy, scope) {
  if (copy.recordId) return scope.recordIds.includes(copy.recordId);
  if (copy.fromRecordId) return scope.recordIds.includes(copy.fromRecordId) || scope.recordIds.includes(copy.toRecordId);
  if (copy.dependents) return intersects(copy.dependents, scope.recordIds);
  if (copy.targets) return copy.targets.some(t => scope.recordIds.includes(t.recordId));
  return scope.keyIds.includes(copy.keyId) || intersects(copy.protects, scope.containerIds);
}
H.composeRetentionReaders({
  locations: {
    discover: at => { if (world.discoveryFails) throw new Error('discovery unavailable'); return { checkedAt: at, complete: true, locationIds: world.discovered ?? LOCATION_IDS }; },
    list: (locationId, scope) => {
      world.listings++;
      if (world.failing.has(locationId)) throw new Error('storage unavailable');
      const containers = world.containers.get(locationId).filter(c => intersects(c.members, scope.recordIds) || intersects(c.replaces, scope.containerIds))
        .map(c => { const inScope = c.members.filter(m => scope.recordIds.includes(m));
          return { containerId: c.containerId, scopeMembers: inScope, otherMembers: c.members.length - inScope.length + c.others, keyIds: c.keyIds,
            replaces: c.replaces, restoreExcludes: c.restoreExcludes.filter(m => inScope.includes(m)), restoreCheck: c.restoreCheck }; });
      return clone({ locationId, checkedAt: world.stale.has(locationId) ? '2000-01-01T00:00:00.000Z' : scope.at, complete: !world.incomplete.has(locationId),
        copies: world.copies.get(locationId).filter(c => names(c, scope)), containers, unattributed: world.unattributed.get(locationId) ?? 0 });
    },
  },
  accessEvents: { load: eventId => { if (!world.events.has(eventId)) throw new Error('event unavailable'); return clone(world.events.get(eventId)); } },
}, REGISTRY);
if (!process.env.KIN_EMR_H_LIST_CASES) beforeEach(() => resetWorld());

const put = (locationId, copy) => { world.copies.get(locationId).push(copy); return copy; };
const remove = (locationId, predicate) => world.copies.set(locationId, world.copies.get(locationId).filter(c => !predicate(c)));
/** The record's originals: each part (and signed payload) in its original place and in the database replica. */
function place(record, { at = 'db', replica = at === 'db' } = {}) {
  for (const where of replica ? [at, 'replica'] : [at]) for (const part of record.parts) {
    const e = part.evidence.event;
    put(where, { copyId: `${where}/${record.recordId}/${part.partId}`, content: 'record-part', recordId: record.recordId, partId: part.partId, sha256: e.sha256, containerId: null });
    if (e.signature) put(where, { copyId: `${where}/${record.recordId}/${part.partId}/sig`, content: 'signature-payload', recordId: record.recordId, partId: part.partId, sha256: e.sha256, containerId: null });
    for (const c of e.components) put(where === 'orthanc' ? 'db' : where, { copyId: `${where}/ref/${record.recordId}/${part.partId}/${c.recordId}`, content: 'reference-entry',
      fromRecordId: record.recordId, fromPartId: part.partId, toRecordId: c.recordId, toPartId: c.partId, relation: 'incorporation', containerId: null });
  }
  return record;
}
function navigation(from, to, where = 'db') {
  const ref = { fromRecordId: from.recordId, fromPartId: from.parts[0].partId, toRecordId: to.recordId, toPartId: to.parts[0].partId, relation: 'navigation' };
  put(where, { copyId: `${where}/nav/${from.recordId}/${to.recordId}`, content: 'reference-entry', ...ref, containerId: null });
  return ref;
}
function container(locationId, containerId, records, options = {}) {
  const c = { containerId, members: records.map(r => r.recordId ?? r), others: 0, keyIds: [], replaces: [], restoreExcludes: [], restoreCheck: null, ...options };
  world.containers.get(locationId).push(c);
  for (const record of records.filter(r => r.parts)) for (const part of record.parts)
    put(locationId, { copyId: `${locationId}/${containerId}/${record.recordId}/${part.partId}`, content: 'record-part', recordId: record.recordId,
      partId: part.partId, sha256: part.evidence.event.sha256, containerId });
  return c;
}
function key(keyId, protects, locations = ['keys', 'keybackup']) {
  for (const where of locations) put(where, { copyId: `${where}/${keyId}`, content: 'key-material', keyId, protects });
}
const removeContainer = (containerId, locations = LOCATION_IDS) => { for (const where of locations) {
  world.containers.set(where, world.containers.get(where).filter(c => c.containerId !== containerId)); remove(where, c => c.containerId === containerId); } };
const restoredOk = at => ({ checkedAt: at, outcome: 'restored', signatures: 'verified', permissions: 'verified', missingLive: 0 });
const durable = { append: async e => ({ durableAt: `${e.day}T23:59:59.999Z` }) };
const receipt = at => ({ completedAt: at, method: 'irreversible-permanent-deletion' });
/** A synthetic round-2 worker: it erases exactly the plan fixed under the lock, nothing it decides itself. */
function worker(at) {
  return async set => {
    const plan = H.fixedErasurePlan(set);
    for (const item of plan.items.filter(i => i.disposition === 'erase' && i.containerId === null)) remove(item.locationId, c => c.copyId === item.copyId);
    for (const c of plan.containers.filter(x => x.disposition === 'erase-container')) removeContainer(c.containerId);
    for (const k of plan.keys.filter(x => x.disposition === 'erase')) for (const where of k.locationIds) remove(where, c => c.keyId === k.keyId);
    world.lastPlan = plan;
    return receipt(at);
  };
}
async function destroy(records, at, graph, destroySet = worker(at), lock = {}) {
  const journal = []; let deletes = 0;
  const append = async e => { journal.push(e); return (lock.append ?? durable.append)(e); };
  const counted = async set => { deletes++; return destroySet(set); };
  let result;
  if (records.length === 1 && !lock.batch) {
    const store = H.inventoryGate({ append, withRetentionLock: async (id, time, work) => work(graph) });
    result = await D.destroyAtExpiry(store, { record: records[0], versionIds: records[0].parts.map(p => p.partId), requestedAt: at, graph },
      request => counted([request]));
  } else {
    const store = H.inventoryGate({ append, withRetentionBatchLock: async (ids, time, work) => work(graph) });
    result = await D.destroyBatchAtExpiry(store, { units: records.map(record => ({ record, versionIds: record.parts.map(p => p.partId) })), requestedAt: at, graph }, counted);
  }
  return { result, journal, deletes };
}
async function refused(records, at, graph, code, message) {
  const before = clone({ records, graph, copies: world.copies, containers: world.containers });
  const journal = []; let deletes = 0, error;
  try { await destroy(records, at, graph, async set => { deletes++; return receipt(at); }, { append: async e => { journal.push(e); return durable.append(e); } }); }
  catch (e) { error = e; }
  assert.equal(error?.code, code, message);
  assert.equal(deletes, 0, message + ' (no deletion call)');
  assert.equal(journal.filter(e => e.phase === 'started').length, 0, message + ' (no started record)');
  assert.deepEqual({ records, graph, copies: world.copies, containers: world.containers }, before, message + ' (originals preserved)');
}
const reasonCodes = assessment => assessment.reasons.map(r => r.code);
function signedReport(recordId, at = t0) {
  const report = place(makeRecord(recordId, 'report-version', at));
  put('db', { copyId: `db/map/${recordId}`, content: 'source-mapping', recordId, containerId: null });
  return report;
}

// ---------------------------------------------------------------------------------------------------------------
test('TEST-H-03/inventory_refusal: a complete current inventory fixes one plan and the set is erased exactly once', async () => {
  const report = signedReport('report-ok');
  put('cache', { copyId: 'cache/pdf/report-ok', content: 'derived-copy', recordId: 'report-ok', partId: report.parts[0].partId, containerId: null });
  put('db', { copyId: 'db/reg/solo', content: 'identity-evidence', registrationId: 'reg-solo', dependents: ['report-ok'], containerId: null });
  container('backup', 'backup-1', [report], { keyIds: ['k-1'] }); container('offsite', 'backup-1', [report], { keyIds: ['k-1'] });
  key('k-1', ['backup-1']);
  const at = D.retentionDeadline(report), graph = snapshotFor([report], at);
  const outcome = await destroy([report], at, graph);
  assert.equal(outcome.deletes, 1, 'a complete inventory lets the set be erased once');
  assert.deepEqual(outcome.journal.map(e => e.phase), ['started', 'completed']);
  const plan = world.lastPlan;
  assert.equal(plan.status, 'erasable');
  assert(plan.items.every(i => i.disposition === 'erase'), 'every copy owned by the set is planned for erasure');
  assert.deepEqual(plan.containers.map(c => [c.containerId, c.disposition, c.locationIds]), [['backup-1', 'erase-container', ['backup', 'offsite']]]);
  assert.deepEqual(plan.keys.map(k => [k.keyId, k.disposition]), [['k-1', 'erase']]);
  assert.equal(H.verifyErasure(plan, at).status, 'verified', 'the plan reached every copy');
});

test('TEST-H-03/inventory_refusal: a listing that fails is an incomplete inventory, never an empty place', async () => {
  const report = signedReport('report-failing');
  container('backup', 'backup-f', [report]);
  const at = D.retentionDeadline(report), graph = snapshotFor([report], at);
  world.failing.add('backup');
  const assessment = H.assessErasure([report], graph, at);
  assert.equal(assessment.status, 'incomplete', 'a failed listing must stop the set before any start');
  assert(reasonCodes(assessment).includes('LocationListingFailed'));
  await refused([report], at, graph, 'InventoryIncomplete', 'a failed listing must stop the set before any start');
});

const DEFECTS = {
  'listing-incomplete': () => { world.incomplete.add('offsite'); return 'LocationListingIncomplete'; },
  'listing-stale': () => { world.stale.add('cache'); return 'LocationListingStale'; },
  'discovery-failed': () => { world.discoveryFails = true; return 'LocationDiscoveryFailed'; },
  'unregistered-location': () => { world.discovered = [...LOCATION_IDS, 'usb-export-7']; return 'UnregisteredLocation'; },
  'registered-location-not-found': () => { world.discovered = LOCATION_IDS.filter(id => id !== 'worm'); return 'RegisteredLocationNotFound'; },
  'duplicate-copy': r => { put('replica', clone(world.copies.get('replica')[0])); return 'DuplicateCopy'; },
  'unknown-part': r => { put('replica', { copyId: 'replica/ghost', content: 'record-part', recordId: r.recordId, partId: 'ghost-version', sha256: 'cd'.repeat(32), containerId: null }); return 'PartUnknown'; },
  'hash-mismatch': r => { world.copies.get('replica')[0].sha256 = 'ef'.repeat(32); return 'PartHashMismatch'; },
  'original-missing': r => { remove('db', c => c.content === 'record-part'); return 'OriginalMissing'; },
  'payload-missing': r => { remove('db', c => c.content === 'signature-payload'); return 'SignaturePayloadMissing'; },
  'unattributed-item': () => { world.unattributed.set('cache', 1); return 'OwnerUnknown'; },
  'container-unknown': r => { put('backup', { copyId: 'backup/x', content: 'record-part', recordId: r.recordId, partId: r.parts[0].partId, sha256: r.parts[0].evidence.event.sha256, containerId: 'backup-x' }); return 'ContainerUnknown'; },
  'container-required': r => { put('backup', { copyId: 'backup/loose', content: 'source-mapping', recordId: r.recordId, containerId: null }); return 'ContainerRequired'; },
  'content-not-registered': r => { put('cache', { copyId: 'cache/sig', content: 'signature-payload', recordId: r.recordId, partId: r.parts[0].partId, sha256: r.parts[0].evidence.event.sha256, containerId: null }); return 'ContentNotRegistered'; },
  'concurrent-reference': r => { put('db', { copyId: 'db/new-ref', content: 'reference-entry', fromRecordId: 'cvr-new', fromPartId: 'c1', toRecordId: r.recordId, toPartId: r.parts[0].partId, relation: 'incorporation', containerId: null }); return 'ReferenceNotInSnapshot'; },
  'stream-mismatch': r => { put('ledger', { copyId: 'ledger/mis', content: 'access-entry', eventId: 'event-mis', stream: 'viewing', occurredAt: t0, action: 'approve-sign', result: 'succeeded', targets: [{ kind: 'report-version', recordId: r.recordId }], containerId: null }); return 'AccessStreamMismatch'; },
  'key-unknown': r => { container('backup', 'backup-k', [r], { keyIds: ['k-missing'] }); return 'KeyUnknown'; },
  'container-members-disagree': r => { container('backup', 'same', [r]); container('offsite', 'same', [r], { others: 1 }); return 'ContainerInconsistent'; },
};
for (const [name, apply] of Object.entries(DEFECTS)) {
  test('TEST-H-03/inventory_refusal: ' + name + ' starts nothing', async () => {
    const report = signedReport('report-' + name);
    const at = D.retentionDeadline(report), graph = snapshotFor([report], at);
    const expected = apply(report);
    const assessment = H.assessErasure([report], graph, at);
    assert.equal(assessment.status, 'incomplete', `defect ${name} must stop the set`);
    assert(reasonCodes(assessment).includes(expected), `defect ${name} must be reported as ${expected}`);
    await refused([report], at, graph, 'InventoryIncomplete', `defect ${name} must stop the set`);
  });
}

test('TEST-H-03/inventory_refusal: the index and the snapshot A checked must name the same references', async () => {
  const report = signedReport('report-indexed'), later = place(makeRecord('report-citing', 'report-version', shift(t0, 400 * DAY)));
  const at = D.retentionDeadline(report);
  const nav = { fromRecordId: later.recordId, fromPartId: later.parts[0].partId, toRecordId: report.recordId, toPartId: report.parts[0].partId, relation: 'navigation' };
  const graph = snapshotFor([report, later], at, [nav]);
  const missing = H.assessErasure([report], graph, at);
  assert(reasonCodes(missing).includes('ReferenceEntryMissing'), 'an index that lost a reference must stop the set');
  await refused([report], at, graph, 'InventoryIncomplete', 'an index that lost a reference must stop the set');
  navigation(later, report);
  assert.equal(H.assessErasure([report], graph, at).status, 'erasable', 'the complete index lets the set proceed');
});

test('TEST-H-03/inventory_refusal: units A will refuse are not read and reach A refusal', async () => {
  const image = place(makeRecord('image-early', 'image', t0), { at: 'orthanc' });
  const at = D.retentionDeadline(image);
  await refused([image], shift(at, -1), snapshotFor([image], shift(at, -1)), 'RetentionNotElapsed', 'a unit before its deadline reaches A refusal');
  assert.equal(world.listings, 0, 'no inventory is read for a unit A refuses');
});

test('TEST-H-03/inventory_refusal: a lawful incorporation cycle is erased as one set, never alone and never kept forever', async () => {
  const a1 = makeRecord('cycle-A', 'report-version', t0, 'a1');
  const b1 = makeRecord('cycle-B', 'report-version', t0, 'b1', { event: { components: [component(a1)] } });
  const a2 = addPart(a1, 'a2', t0, { event: { act: 'additional-entry', components: [component(b1), component(a1)] } }, snapshotFor([a1, b1], t0));
  place(a2); place(b1);
  const at = D.retentionDeadline(a2), graph = snapshotFor([a2, b1], at);
  const alone = H.assessErasure([a2], graph, at);
  assert.equal(alone.status, 'blocked', 'a cycle member cannot leave while its partner incorporates it');
  assert(reasonCodes(alone).includes('LiveIncorporator'));
  const both = await destroy([a2, b1], at, graph, worker(at), { batch: true });
  assert.equal(both.deletes, 1, 'the cycle is erased in one atomic call');
  assert(world.lastPlan.items.filter(i => i.content === 'reference-entry').every(i => i.disposition === 'erase'), 'references inside the set leave with it');
  assert.equal(H.verifyErasure(world.lastPlan, at).status, 'verified');
});

// ---------------------------------------------------------------------------------------------------------------
test('TEST-H-01/period_extension: retained before expiry and through one lawful extension, erasable at its end', async () => {
  const image = remember(place(makeRecord('image-ext', 'image', t0), { at: 'orthanc' }));
  const deadline = D.retentionDeadline(image);
  await refused([image], shift(deadline, -1), snapshotFor([image], shift(deadline, -1)), 'RetentionNotElapsed', 'kept until the last millisecond of its period');
  const years = D.retentionFor(image.kinds).retentionYears;
  const extended = remember(D.extendRetention(image, { cause: 'continuing-treatment', actorId: 'synthetic-reader', reason: 'continuing treatment',
    at: shift(deadline, -DAY), until: D.civilPeriodEnd(deadline, years) }));
  assert.throws(() => D.extendRetention(extended, { cause: 'continuing-treatment', actorId: 'synthetic-reader', reason: 'again', at: shift(deadline, -DAY), until: shift(deadline, DAY) }));
  const end = D.retentionDeadline(extended);
  assert(end > deadline);
  await refused([extended], deadline, snapshotFor([extended], deadline), 'RetentionNotElapsed', 'a lawful extension keeps the record past its own period');
  assert.equal((await destroy([extended], end, snapshotFor([extended], end))).deletes, 1, 'erasable when the extension ends');
});

test('TEST-H-01/period_extension: a read never becomes a retained part and never restarts the period', () => {
  const image = makeRecord('image-read', 'image', t0), before = D.retentionDeadline(image);
  const read = stored('image', image.recordId, 'read-1', shift(t0, 900 * DAY), { event: { act: 'read', predecessor: component(image) } });
  assert.throws(() => D.recordVersionAdded(image, read, snapshotFor([image], read.event.at)), { code: 'NewLawfulRecordEventRequired' },
    'a read must never become a retained part');
  assert.equal(D.retentionDeadline(image), before);
});

test('TEST-H-01/period_extension: a comparison link from a live report does not stretch the compared image', async () => {
  const image = place(makeRecord('image-compared', 'image', t0), { at: 'orthanc' });
  put('cache', { copyId: 'cache/thumb/image-compared', content: 'derived-copy', recordId: image.recordId, partId: image.parts[0].partId, containerId: null });
  const report = place(makeRecord('report-later', 'report-version', shift(t0, 400 * DAY)));
  const at = D.retentionDeadline(image);
  assert(D.retentionDeadline(report) > at, 'the comparing report is still alive');
  const graph = snapshotFor([image, report], at, [navigation(report, image)]);
  assert.equal(H.assessErasure([image], graph, at).status, 'erasable', 'a navigation link from a live record must not retain the compared image');
  const outcome = await destroy([image], at, graph);
  assert.equal(outcome.deletes, 1, 'a navigation link from a live record must not retain the compared image');
  assert.deepEqual(world.lastPlan.items.filter(i => i.content === 'reference-entry').map(i => i.disposition), ['retain-other-record']);
  resetWorld();
  const base = place(makeRecord('image-incorporated', 'image', t0), { at: 'orthanc' });
  const cvr = place(makeRecord('cvr-incorporating', 'critical-result', shift(t0, 400 * DAY), 'c1', { event: { components: [component(base)] } }));
  const own = D.retentionDeadline(base, snapshotFor([base], t0)), held = snapshotFor([base, cvr], own);
  await refused([base], own, held, 'RetentionNotElapsed', 'an image actually incorporated by a live record stays for that record');
  assert(D.retentionDeadline(cvr) > own);
});

test('TEST-H-01/period_extension: access units leave by their stream at destruction time', async () => {
  const viewing = access({ eventId: 'view-1' }), change = changeEvent('change-1', t0, ['report-1']), permission = permissionEvent('perm-1', t0);
  const failure = access({ eventId: 'refused-1', action: 'permission-refused', result: 'refused' });
  const units = {};
  for (const event of [viewing, change, permission, failure]) {
    world.events.set(event.eventId, event);
    units[event.eventId] = A.accessRetention(event);
  }
  const placeUnit = unit => put('ledger', { copyId: `ledger/${unit.recordId}`, content: 'record-part', recordId: unit.recordId, partId: unit.parts[0].partId,
    sha256: unit.parts[0].evidence.event.sha256, containerId: null });
  const two = K.accessFloor('viewing', t0), three = K.accessFloor('permission-history', t0);
  assert.equal(two, D.civilPeriodEnd(t0, 2), 'a viewing event is kept for its two-year floor');
  assert.equal(three, D.civilPeriodEnd(t0, 3), 'a permission change is kept three years');
  const go = async (unit, at) => { resetWorld(); for (const e of [viewing, change, permission, failure]) world.events.set(e.eventId, e); placeUnit(unit);
    return destroy([unit], at, snapshotFor([unit], at)); };
  const reject = async (unit, at, code, message) => { resetWorld(); for (const e of [viewing, change, permission, failure]) world.events.set(e.eventId, e); placeUnit(unit);
    await refused([unit], at, snapshotFor([unit], at), code, message); };
  await reject(units['view-1'], shift(two, -1), 'RetentionNotElapsed', 'a viewing event is kept for its two-year floor');
  assert.equal((await go(units['view-1'], two)).deletes, 1, 'a viewing event leaves at its own floor');
  assert.equal((await go(units['refused-1'], two)).deletes, 1, 'an event without a record leaves at two years');
  await reject(units['perm-1'], two, 'RetentionRuleActive', 'a permission change is kept three years');
  assert.equal((await go(units['perm-1'], three)).deletes, 1, 'a permission change leaves at three years');
  await reject(units['change-1'], shift(three, 365 * DAY), 'RetentionRuleActive', 'change history never leaves alone, only with its record');
  resetWorld(); placeUnit(units['view-1']); world.events.set('view-1', { ...viewing, requestId: 'tampered' });
  const tampered = H.assessErasure([units['view-1']], snapshotFor([units['view-1']], two), two);
  assert(reasonCodes(tampered).includes('AccessEventBindingRefused'), 'a stored event that is not the one A sealed cannot release its unit');
  world.events.clear();
  assert(reasonCodes(H.assessErasure([units['view-1']], snapshotFor([units['view-1']], two), two)).includes('AccessEventUnavailable'));
});

test('TEST-H-01/period_extension: change history leaves with its record, its last two-year remainder and viewing stay', async () => {
  const report = signedReport('report-history');
  const at = D.retentionDeadline(report), late = shift(at, -300 * DAY);
  const entry = (eventId, stream, action, result, occurredAt, recordIds) => put('ledger', { copyId: `ledger/${eventId}`, content: 'access-entry', eventId, stream,
    occurredAt, action, result, targets: recordIds.map(id => ({ kind: 'report-version', recordId: id })), containerId: null });
  entry('old-change', 'change-history', 'approve-sign', 'succeeded', t0, [report.recordId]);
  entry('late-change', 'change-history', 'archive', 'succeeded', late, [report.recordId]);
  entry('old-view', 'viewing', 'provide-prepared', 'prepared', t0, [report.recordId]);
  entry('shared-change', 'change-history', 'approve-sign', 'succeeded', t0, [report.recordId, 'report-elsewhere']);
  const assessment = H.assessErasure([report], snapshotFor([report], at), at);
  assert.equal(assessment.status, 'erasable');
  const of = id => assessment.items.find(i => i.copyId === `ledger/${id}`).disposition;
  assert.equal(of('old-change'), 'erase', 'change history older than its floor leaves with the record');
  assert.equal(of('late-change'), 'retain-viewing-remainder', 'the last two-year remainder of change history stays behind');
  assert.equal(of('old-view'), 'retain-stream-floor', 'viewing events follow their own stream floor');
  assert.equal(of('shared-change'), 'retain-other-record', 'history shared with a live record stays');
  remove('db', () => true); remove('replica', () => true);
  assert.equal(H.verifyErasure(assessment, at).status, 'partial', 'change history still present keeps the erasure partial');
  remove('ledger', c => c.eventId === 'old-change');
  assert.equal(H.verifyErasure(assessment, at).status, 'verified', 'retained streams are not leftovers');
});

// ---------------------------------------------------------------------------------------------------------------
test('TEST-H-02/archive_and_holds: an active hold reaches A refusal and nothing is read', async () => {
  const image = place(makeRecord('image-held', 'image', t0), { at: 'orthanc' });
  const held = holdRecord(image, holdFacts(image.recordId));
  const at = D.retentionDeadline(held);
  await refused([held], at, snapshotFor([held], at), 'LegalHoldActive', 'a held record is never erased');
  assert.equal(world.listings, 0);
});

test('TEST-H-02/archive_and_holds: a request hold released at its old until cannot free a record whose request is unresolved', async () => {
  const image = place(makeRecord('image-request', 'image', t0), { at: 'orthanc' });
  const until = shift(t0, 10 * DAY), h = pendingHold(image.recordId, t0, until);
  const held = holdRecord(image, h);
  // The response deadline was lawfully extended after the hold was registered (legal register L5-06).
  requestRows.get(h.basis.requestId).responseDueAt = shift(t0, 40 * DAY);
  const released = remember(D.liftLegalHold(held, h.holdId, dutyReader(releaseFacts(h, shift(until, DAY), {
    reason: 'effect-ended', evidenceId: 'expiry-confirmation', endingFact: { kind: 'validity-expired', at: until } }))));
  const at = D.retentionDeadline(released), graph = snapshotFor([released], at);
  const assessment = H.assessErasure([released], graph, at);
  assert(reasonCodes(assessment).includes('UnresolvedRequestHold'), 'a hold released at its old until cannot free an unresolved request');
  await refused([released], at, graph, 'RetentionRuleActive', 'a hold released at its old until cannot free an unresolved request');
  requestRows.get(h.basis.requestId).resolution = { eventId: 'answered-1', at: shift(t0, 30 * DAY), outcome: 'fulfilled' };
  assert.equal((await destroy([released], at, graph)).deletes, 1, 'once the request is resolved the record leaves at its period');
});

// ---------------------------------------------------------------------------------------------------------------
function sharedBackup(recordId) {
  const report = signedReport(recordId);
  for (const where of ['backup', 'offsite']) container(where, 'backup-old', [report], { others: 1, keyIds: ['k-old', 'k-shared'] });
  key('k-old', ['backup-old']); key('k-shared', ['backup-old', 'backup-other']);
  const at = D.retentionDeadline(report);
  return { report, at, assessment: H.assessErasure([report], snapshotFor([report], at), at) };
}
function workerDone(report, options = {}) {
  remove('db', () => true); remove('replica', () => true);
  if (options.keepOld !== true) removeContainer('backup-old', options.oldFrom ?? LOCATION_IDS);
  if (options.replacement !== false) for (const where of options.replacementLocations ?? ['backup', 'offsite']) container(where, 'backup-new', options.replacementMembers ?? ['live-record-1'],
    { keyIds: options.replacementKeys ?? ['k-new'], replaces: ['backup-old'], restoreCheck: options.restoreCheck ?? restoredOk(shift(D.retentionDeadline(report), 60_000)) });
  if (options.keepOldKey !== true) for (const where of ['keys', 'keybackup']) remove(where, c => c.keyId === 'k-old');
  if (options.replacement !== false) for (const keyId of options.replacementKeys ?? ['k-new']) key(keyId, ['backup-new']);
}
test('TEST-H-04/expired_restore_impossible: shared backups are replaced and a key that opens kept data is retained', () => {
  const { assessment } = sharedBackup('report-shared');
  assert.equal(assessment.status, 'erasable');
  assert.deepEqual(assessment.containers.map(c => [c.containerId, c.disposition]), [['backup-old', 'replace-container']], 'live data inside makes a replacement, not a deletion');
  const keys = Object.fromEntries(assessment.keys.map(k => [k.keyId, k.disposition]));
  assert.equal(keys['k-shared'], 'retain-live-key', 'a key that still opens a kept container must be retained');
  assert.equal(keys['k-old'], 'erase', 'a key that only opens removed containers is erased with them');
});

test('TEST-H-04/expired_restore_impossible: only physical absence everywhere plus a verified replacement completes the erasure', () => {
  const { report, at, assessment } = sharedBackup('report-verify');
  const later = shift(at, 3_600_000);
  const v0 = H.verifyErasure(assessment, later);
  assert.equal(v0.status, 'partial');
  assert(reasonCodes(v0).includes('ReplacementUnverified'));
  workerDone(report);
  const done = H.verifyErasure(assessment, later);
  assert.equal(done.status, 'verified', 'the expired record is gone everywhere and the live data restores');
  assert.deepEqual(done.remaining, []);
});

test('TEST-H-04/expired_restore_impossible: an old backup kept offsite keeps the erasure partial', () => {
  const { report, at, assessment } = sharedBackup('report-offsite');
  workerDone(report, { oldFrom: ['backup'] });
  const v = H.verifyErasure(assessment, shift(at, 3_600_000));
  assert.equal(v.status, 'partial', 'an old backup copy kept offsite keeps the erasure partial');
  assert(reasonCodes(v).includes('ContainerRemains'));
});

test('TEST-H-04/expired_restore_impossible: a restore filter never counts as erasure', () => {
  const { report, at, assessment } = sharedBackup('report-filter');
  workerDone(report, { keepOld: true });
  for (const where of ['backup', 'offsite']) for (const c of world.containers.get(where)) if (c.containerId === 'backup-old') c.restoreExcludes = [report.recordId];
  const v = H.verifyErasure(assessment, shift(at, 3_600_000));
  assert.equal(v.status, 'partial', 'a restore filter never counts as erasure');
});

test('TEST-H-04/expired_restore_impossible: replacements that lose live data, carry expired data or use an erased key fail', () => {
  const cases = [
    [{ restoreCheck: { ...restoredOk(t0), missingLive: 1 } }, 'LiveDataLost', 'a replacement missing live data with the old backup gone is a failure'],
    [{ replacement: false }, 'LiveDataLost', 'removing the old backup without a replacement loses live data'],
    [{ replacementMembers: ['live-record-1', 'EXPIRED'] }, 'ExpiredDataInReplacement', 'a replacement must not carry the expired record'],
    [{ replacementKeys: ['k-old'] }, 'ReplacementUsesErasedKey', 'a replacement must not depend on a key being erased'],
  ];
  for (const [options, code, message] of cases) {
    resetWorld();
    const { report, at, assessment } = sharedBackup('report-fail-' + code);
    if (options.replacementMembers) options.replacementMembers = options.replacementMembers.map(m => m === 'EXPIRED' ? report.recordId : m);
    if (options.restoreCheck) options.restoreCheck = { ...options.restoreCheck, checkedAt: shift(at, 60_000) };
    workerDone(report, options);
    const v = H.verifyErasure(assessment, shift(at, 3_600_000));
    assert.equal(v.status, 'failed', message); assert(reasonCodes(v).includes(code), message);
  }
  resetWorld();
  const kept = sharedBackup('report-key-lost');
  workerDone(kept.report);
  for (const where of ['keys', 'keybackup']) remove(where, c => c.keyId === 'k-shared');
  assert.equal(H.verifyErasure(kept.assessment, shift(kept.at, 3_600_000)).status, 'failed', 'losing a retained key loses live data');
  resetWorld();
  const left = sharedBackup('report-key-left');
  workerDone(left.report, { keepOldKey: true });
  const v = H.verifyErasure(left.assessment, shift(left.at, 3_600_000));
  assert.equal(v.status, 'partial'); assert(reasonCodes(v).includes('KeyRemains'), 'a key recovery copy left behind keeps the erasure partial');
});

test('TEST-H-04/expired_restore_impossible: the completion record holds kinds, counts, time and method only', () => {
  const { report, at, assessment } = sharedBackup('report-summary');
  assert.throws(() => H.erasureSummary(H.verifyErasure(assessment, at)), { code: 'VerifiedErasureRequired' }, 'no completion record before verification');
  workerDone(report);
  const v = H.verifyErasure(assessment, shift(at, 3_600_000));
  const summary = H.erasureSummary(v), text = JSON.stringify(summary);
  const secrets = [report.recordId, ...report.parts.flatMap(p => [p.partId, p.evidence.event.sha256, p.evidence.event.eventId]),
    'backup-old', 'k-old', 'k-shared', 'SYN-PATIENT-1', ...assessment.items.map(i => i.copyId)];
  for (const secret of secrets) assert(!text.includes(secret), 'the completion record carries no identifier or digest');
  assert.equal(summary.units, 1); assert.equal(summary.method, 'irreversible-permanent-deletion');
  assert(summary.locations.some(l => l.locationClass === 'backup-snapshot' && l.replacedContainers === 1));
});

// H-R1-SOL-01/02: the reviewer's CE-1..3 must refuse completion without changing any listed bytes or metadata.
function verifyWithoutWrites(assessment, at) {
  const before = clone({ copies: world.copies, containers: world.containers });
  const result = H.verifyErasure(assessment, at);
  assert.deepEqual({ copies: world.copies, containers: world.containers }, before, 'verification preserves the stored copies and manifests');
  return result;
}
test('TEST-H-04/expired_restore_impossible: CE-1 expired identity evidence inside an empty-scope replacement refuses completion', () => {
  const report = signedReport('ce-1-expired-evidence');
  const evidence = where => ({ copyId: where + '/expired-registration', content: 'identity-evidence', registrationId: 'expired-registration',
    dependents: [report.recordId], containerId: 'backup-old' });
  for (const where of ['backup', 'offsite']) {
    container(where, 'backup-old', [report], { others: 1, keyIds: ['k-old', 'k-shared'] });
    put(where, evidence(where));
  }
  key('k-old', ['backup-old']); key('k-shared', ['backup-old', 'backup-other']);
  const at = D.retentionDeadline(report), assessment = H.assessErasure([report], snapshotFor([report], at), at);
  assert.equal(assessment.status, 'erasable');
  workerDone(report);
  for (const where of ['backup', 'offsite']) put(where, { ...evidence(where), containerId: 'backup-new' });
  const result = verifyWithoutWrites(assessment, shift(at, 3_600_000));
  assert.equal(result.status, 'failed', 'expired identity evidence inside a replacement prevents completion');
  for (const locationId of ['backup', 'offsite']) {
    assert(result.reasons.some(r => r.code === 'ExpiredDataInReplacement' && r.locationId === locationId));
    assert(result.reasons.some(r => r.code === 'ContainerInconsistent' && r.locationId === locationId));
  }
  assert.throws(() => H.erasureSummary(result), { code: 'VerifiedErasureRequired' });
  for (const where of ['backup', 'offsite']) remove(where, c => c.content === 'identity-evidence');
  assert.equal(verifyWithoutWrites(assessment, shift(at, 3_600_000)).status, 'verified', 'removing expired evidence permits verification');
});

test('TEST-H-06/crash_resume: CE-3 a new incorporation inside an empty-scope replacement refuses completion', () => {
  const report = signedReport('ce-3-new-incorporation'), at = D.retentionDeadline(report);
  container('backup', 'backup-old', [report], { others: 1 });
  const assessment = H.assessErasure([report], snapshotFor([report], at), at);
  assert.equal(assessment.status, 'erasable');
  workerDone(report, { replacementLocations: ['backup'], replacementKeys: [] });
  const ref = put('backup', { copyId: 'incoming-reference', content: 'reference-entry', fromRecordId: 'live-outside', fromPartId: 'live-part',
    toRecordId: report.recordId, toPartId: report.parts[0].partId, relation: 'incorporation', containerId: 'backup-new' });
  const result = verifyWithoutWrites(assessment, shift(at, 3_600_000));
  assert.equal(result.status, 'partial', 'a new incorporation inside a replacement prevents completion');
  assert(result.reasons.some(r => r.code === 'LiveIncorporator' && r.locationId === 'backup'));
  assert.throws(() => H.erasureSummary(result), { code: 'VerifiedErasureRequired' });
  ref.relation = 'navigation';
  assert.equal(verifyWithoutWrites(assessment, shift(at, 3_600_000)).status, 'verified', 'a navigation reference does not retain the expired record');
});

test('TEST-H-05/key_lifetime: CE-2 a past restore cannot replace missing current replacement keys', () => {
  const { report, at, assessment } = sharedBackup('ce-2-new-key');
  workerDone(report);
  for (const where of ['keys', 'keybackup']) remove(where, c => c.keyId === 'k-new');
  const result = verifyWithoutWrites(assessment, shift(at, 3_600_000));
  assert.equal(result.status, 'failed', 'a missing current replacement key prevents completion despite a past restore');
  assert(reasonCodes(result).includes('LiveKeyLost'));
  assert.throws(() => H.erasureSummary(result), { code: 'VerifiedErasureRequired' });
  key('k-new', ['backup-new']);
  const restored = verifyWithoutWrites(assessment, shift(at, 3_600_000));
  assert.equal(restored.status, 'verified');
  assert.equal(H.erasureSummary(restored).units, 1, 'current keys and recovery copies allow completion');
});

for (const missing of ['keys', 'keybackup']) {
  test('TEST-H-05/key_lifetime: a replacement preserves the required key copy at ' + missing, () => {
    const { report, at, assessment } = sharedBackup('new-key-copy-' + missing);
    workerDone(report);
    remove(missing, c => c.keyId === 'k-new');
    const result = verifyWithoutWrites(assessment, shift(at, 3_600_000));
    assert.equal(result.status, 'failed', 'a missing required replacement key copy prevents completion at ' + missing);
    assert(reasonCodes(result).includes('LiveKeyLost'));
    assert.throws(() => H.erasureSummary(result), { code: 'VerifiedErasureRequired' });
    key('k-new', ['backup-new'], [missing]);
    assert.equal(verifyWithoutWrites(assessment, shift(at, 3_600_000)).status, 'verified');
  });
}

test('TEST-H-05/key_lifetime: each current key copy must protect the replacement it names', () => {
  const { report, at, assessment } = sharedBackup('new-key-protection');
  workerDone(report);
  const recovery = world.copies.get('keybackup').find(c => c.keyId === 'k-new');
  recovery.protects = ['unrelated-backup'];
  const result = verifyWithoutWrites(assessment, shift(at, 3_600_000));
  assert.equal(result.status, 'failed', 'a replacement key copy for another container prevents completion');
  assert(reasonCodes(result).includes('LiveKeyLost'));
  assert.throws(() => H.erasureSummary(result), { code: 'VerifiedErasureRequired' });
  recovery.protects = ['backup-new'];
  assert.equal(verifyWithoutWrites(assessment, shift(at, 3_600_000)).status, 'verified');
});

test('TEST-H-05/key_lifetime: every declared replacement key must exist', () => {
  const { report, at, assessment } = sharedBackup('new-key-multiple');
  workerDone(report, { replacementKeys: ['k-new', 'k-new-second'] });
  for (const where of ['keys', 'keybackup']) remove(where, c => c.keyId === 'k-new-second');
  const result = verifyWithoutWrites(assessment, shift(at, 3_600_000));
  assert.equal(result.status, 'failed', 'one available key cannot cover a missing second replacement key');
  assert.throws(() => H.erasureSummary(result), { code: 'VerifiedErasureRequired' });
  key('k-new-second', ['backup-new']);
  assert.equal(verifyWithoutWrites(assessment, shift(at, 3_600_000)).status, 'verified');
});

test('TEST-H-05/key_lifetime: a replacement can retain shared identity evidence and the viewing remainder', () => {
  const { report, at, assessment } = sharedBackup('replacement-shared-evidence');
  workerDone(report);
  put('backup', { copyId: 'shared-identity', content: 'identity-evidence', registrationId: 'registration-shared',
    dependents: [report.recordId, 'live-record-1'], containerId: 'backup-new' });
  put('backup', { copyId: 'recent-history', content: 'access-entry', eventId: 'recent-change', stream: 'change-history', occurredAt: shift(at, -DAY),
    action: 'approve-sign', result: 'succeeded', targets: [{ kind: 'report-version', recordId: report.recordId }], containerId: 'backup-new' });
  const result = verifyWithoutWrites(assessment, shift(at, 3_600_000));
  assert.equal(result.status, 'verified', 'retained shared evidence and the viewing remainder are allowed inside a replacement');
  assert.equal(H.erasureSummary(result).units, 1);
});

// ---------------------------------------------------------------------------------------------------------------
test('TEST-H-05/key_lifetime: signer evidence stays for live records, expired payloads never stay as evidence', () => {
  const report = signedReport('report-signed');
  put('db', { copyId: 'db/reg/shared', content: 'identity-evidence', registrationId: 'reg-shared', dependents: [report.recordId, 'report-alive'], containerId: null });
  put('db', { copyId: 'db/reg/own', content: 'identity-evidence', registrationId: 'reg-own', dependents: [report.recordId], containerId: null });
  const at = D.retentionDeadline(report), assessment = H.assessErasure([report], snapshotFor([report], at), at);
  const of = id => assessment.items.find(i => i.copyId === id).disposition;
  assert.equal(of('db/reg/shared'), 'retain-shared-evidence', 'identity evidence still needed by a live record is retained');
  assert.equal(of('db/reg/own'), 'erase', 'identity evidence needed by no live record leaves');
  for (const item of assessment.items.filter(i => i.content === 'signature-payload')) assert.equal(item.disposition, 'erase', 'an expired signature payload is never kept as evidence');
  remove('db', c => c.content !== 'identity-evidence' || c.registrationId === 'reg-own');
  remove('replica', c => c.content !== 'signature-payload');
  const v = H.verifyErasure(assessment, at);
  assert.equal(v.status, 'partial', 'a signature payload left in a replica keeps the erasure partial');
  assert.throws(() => D.transitionSigningKey('revoked', 'recover'), Error, 'a revoked key never signs again');
});

// ---------------------------------------------------------------------------------------------------------------
test('TEST-H-06/crash_resume: after a crash the remaining work is exact, repeatable and completes; a lost completion record changes nothing', async () => {
  const report = signedReport('report-crash');
  put('cache', { copyId: 'cache/pdf/report-crash', content: 'derived-copy', recordId: report.recordId, partId: report.parts[0].partId, containerId: null });
  container('backup', 'backup-c', [report], { keyIds: ['k-c'] }); key('k-c', ['backup-c']);
  const at = D.retentionDeadline(report), graph = snapshotFor([report], at);
  const assessment = H.assessErasure([report], graph, at);
  remove('db', () => true);
  const first = H.verifyErasure(assessment, at), second = H.verifyErasure(assessment, at);
  assert.equal(first.status, 'partial');
  assert.deepEqual(second, first, 'verification is idempotent');
  assert.deepEqual(first.remaining.map(r => r.kind).sort(), ['container', 'copy', 'copy', 'copy', 'key', 'key']);
  resetWorld();
  const again = signedReport('report-crash-2');
  container('backup', 'backup-c2', [again], { keyIds: ['k-c2'] }); key('k-c2', ['backup-c2']);
  const at2 = D.retentionDeadline(again), graph2 = snapshotFor([again], at2);
  await assert.rejects(destroy([again], at2, graph2, worker(at2), { append: async e => {
    if (e.phase === 'completed') throw new Error('completion journal unavailable'); return durable.append(e); } }));
  assert.equal(H.verifyErasure(world.lastPlan, at2).status, 'verified', 'storage, not the lost completion record, shows the erasure');
});

test('TEST-H-06/crash_resume: unconfirmed terminals never verify and an unsent original blocks the set', async () => {
  const report = signedReport('report-terminal');
  put('terminals', { copyId: 'terminals/cache/report-terminal', content: 'derived-copy', recordId: report.recordId, partId: report.parts[0].partId, containerId: null });
  const at = D.retentionDeadline(report), graph = snapshotFor([report], at);
  const assessment = H.assessErasure([report], graph, at);
  assert.equal(assessment.status, 'erasable');
  remove('db', () => true); remove('replica', () => true); remove('terminals', () => true);
  world.incomplete.add('terminals');
  assert.equal(H.verifyErasure(assessment, at).status, 'unverified', 'an unreported terminal never verifies the erasure');
  resetWorld();
  const pending = signedReport('report-pending');
  put('terminals', { copyId: 'terminals/pending', content: 'pending-original', recordId: pending.recordId, partId: pending.parts[0].partId, containerId: null });
  const at3 = D.retentionDeadline(pending), graph3 = snapshotFor([pending], at3);
  assert.equal(H.assessErasure([pending], graph3, at3).status, 'blocked', 'an unsent signed original on a terminal blocks the set');
  await refused([pending], at3, graph3, 'ErasureBlocked', 'an unsent signed original on a terminal blocks the set');
  resetWorld();
  const worm = signedReport('report-worm');
  put('worm', { copyId: 'worm/disc', content: 'record-part', recordId: worm.recordId, partId: worm.parts[0].partId, sha256: worm.parts[0].evidence.event.sha256, containerId: null });
  const at4 = D.retentionDeadline(worm);
  assert(reasonCodes(H.assessErasure([worm], snapshotFor([worm], at4), at4)).includes('ImmutableLocation'), 'write-once media cannot be declared erased');
});

// ---------------------------------------------------------------------------------------------------------------
test('TEST-H-07/facility_processor: only domestic registered places, and evidence is linked, never declared compliant', () => {
  const base = clone(REGISTRY);
  const variant = patch => { const r = clone(base); patch(r); return r; };
  assert.throws(() => K.parseLocationRegistry(variant(r => { r.locations[6].country = 'US'; })), { code: 'DomesticLocationRequired' });
  assert.throws(() => K.parseLocationRegistry(variant(r => { r.locations[0].compliant = true; })), 'a compliance flag in settings is not evidence');
  assert.throws(() => K.parseLocationRegistry(variant(r => { r.locations[5].contents = [...r.locations[5].contents, 'key-material']; })), { code: 'LocationContentRefused' });
  assert.throws(() => K.parseLocationRegistry(variant(r => { r.locations[0].contents = ['pending-original']; })), { code: 'LocationContentRefused' });
  assert.throws(() => K.parseLocationRegistry(variant(r => { r.locations = r.locations.filter(l => !['db', 'replica', 'orthanc', 'ledger'].includes(l.locationId) || l.locationId === 'replica'); })), { code: 'OriginalLocationRequired' });
  const configOnly = K.institutionEvidenceStatus(variant(r => r.locations.forEach(l => { l.facilityEvidenceId = null; })));
  assert.equal(configOnly.status, 'missing', 'settings alone never satisfy the facility obligations');
  assert.equal(configOnly.missingLocationIds.length, base.locations.length);
  const linked = K.institutionEvidenceStatus(variant(r => r.locations.forEach((l, i) => { l.facilityEvidenceId = 'evidence-' + i; })));
  assert.equal(linked.status, 'linked', 'linked evidence is the most the product reports; I reviews it');
  const report = signedReport('report-facility'), at = D.retentionDeadline(report);
  const assessment = H.assessErasure([report], snapshotFor([report], at), at);
  assert.equal(assessment.institutionEvidence.status, 'missing');
  assert.deepEqual([...assessment.institutionEvidence.missingLocationIds], ['keybackup', 'offsite', 'terminals', 'worm']);
});

test('TEST-H-07/facility_processor: readers are composed once and assessments cannot be forged', () => {
  assert.throws(() => H.composeRetentionReaders({ locations: { discover() {}, list() {} }, accessEvents: { load() {} } }, REGISTRY), { code: 'RetentionReadersAlreadyComposed' });
  assert.throws(() => H.requireErasable({ status: 'erasable' }), { code: 'ErasureAssessmentRequired' });
  assert.throws(() => H.verifyErasure({ status: 'erasable', recordIds: [], at: t0 }, t0), { code: 'ErasableAssessmentRequired' });
  assert.throws(() => H.fixedErasurePlan([{ record: { recordId: 'x' }, graph: {} }]), { code: 'ErasurePlanRequired' });
});

test('TEST-H-03/inventory_refusal: the assessment itself refuses early expiry and an active hold', () => {
  const image = place(makeRecord('assessment-early', 'image', t0), { at: 'orthanc' });
  const at = D.retentionDeadline(image), early = shift(at, -1);
  const earlyAssessment = H.assessErasure([image], snapshotFor([image], early), early);
  assert.equal(earlyAssessment.status, 'retained', 'inventory completeness cannot grant early destruction');
  assert.throws(() => H.requireErasable(earlyAssessment), { code: 'RetentionRuleActive' });
  const held = holdRecord(image, holdFacts(image.recordId));
  assert.equal(H.assessErasure([held], snapshotFor([held], at), at).status, 'retained', 'inventory completeness cannot override a hold');
});

test('TEST-H-03/inventory_refusal: a fixed SCC plan cannot be consumed by a subset or duplicate member', async () => {
  const a1 = makeRecord('set-a', 'report-version', t0, 'a1');
  const b = makeRecord('set-b', 'report-version', t0, 'b1', { event: { components: [component(a1)] } });
  const a = addPart(a1, 'a2', t0, { event: { act: 'additional-entry', components: [component(b), component(a1)] } }, snapshotFor([a1, b], t0));
  place(a); place(b);
  const at = D.retentionDeadline(a), graph = snapshotFor([a, b], at);
  await destroy([a, b], at, graph, async requests => {
    assert.throws(() => H.fixedErasurePlan([requests[0]]), { code: 'ErasurePlanRequired' }, 'a subset cannot obtain the entire set plan');
    assert.throws(() => H.fixedErasurePlan([requests[0], requests[0]]), { code: 'ErasurePlanRequired' });
    return worker(at)(requests);
  }, { batch: true });
});

test('TEST-H-03/inventory_refusal: independent sets need separate plans before any started journal', async () => {
  const a = signedReport('independent-a'), b = signedReport('independent-b');
  const at = D.retentionDeadline(a), graph = snapshotFor([a, b], at);
  await refused([a, b], at, graph, 'SingleDisposalSetRequired', 'a multi-set batch requires round-2 coordination');
});

test('TEST-H-04/expired_restore_impossible: every replaced backup location must preserve and restore live records', () => {
  const { report, at, assessment } = sharedBackup('replica-replacement');
  workerDone(report, { replacementLocations: ['backup'] });
  const result = H.verifyErasure(assessment, shift(at, 3_600_000));
  assert.equal(result.status, 'failed', 'one good replacement cannot cover a lost offsite backup');
  assert(result.reasons.some(r => r.code === 'LiveDataLost' && r.locationId === 'offsite'));
});

test('TEST-H-05/key_lifetime: verification refuses loss of evidence still needed by a live record', () => {
  const report = signedReport('shared-evidence-lost');
  put('db', { copyId: 'shared-evidence', content: 'identity-evidence', registrationId: 'reg-1', dependents: [report.recordId, 'live-other'], containerId: null });
  const at = D.retentionDeadline(report), assessment = H.assessErasure([report], snapshotFor([report], at), at);
  remove('db', () => true); remove('replica', () => true);
  assert.equal(H.verifyErasure(assessment, at).status, 'failed', 'losing retained evidence is not successful destruction');
});

test('TEST-H-06/crash_resume: a new incoming reference discovered after planning prevents completion', () => {
  const report = signedReport('new-reference');
  const at = D.retentionDeadline(report), assessment = H.assessErasure([report], snapshotFor([report], at), at);
  remove('db', () => true); remove('replica', () => true);
  put('db', { copyId: 'new-ref', content: 'reference-entry', fromRecordId: 'live-other', fromPartId: 'v1', toRecordId: report.recordId,
    toPartId: report.parts[0].partId, relation: 'incorporation', containerId: null });
  const result = H.verifyErasure(assessment, at);
  assert.notEqual(result.status, 'verified', 'a new live incorporator cannot be silently ignored');
  assert(reasonCodes(result).includes('LiveIncorporator'));
});

for (const locationId of ['orthanc', 'cache', 'database-wal-archive', 'database-snapshot', 'object-store-version', 'export-archive', 'staging', 'crash-dump', 'terminals']) {
  test('TEST-H-04/expired_restore_impossible: image copy at ' + locationId + ' must be absent', () => {
    const image = place(makeRecord('image-copy-' + locationId, 'image', t0), { at: 'orthanc' });
    const copy = { copyId: 'copy-' + locationId, content: 'derived-copy', recordId: image.recordId, partId: image.parts[0].partId, containerId: null };
    put(locationId, copy);
    const at = D.retentionDeadline(image), plan = H.assessErasure([image], snapshotFor([image], at), at);
    remove('orthanc', c => c.copyId !== copy.copyId);
    assert.equal(H.verifyErasure(plan, at).status, 'partial', 'an image copy remains at ' + locationId);
    remove(locationId, () => true);
    assert.equal(H.verifyErasure(plan, at).status, 'verified');
  });
}

test('TEST-H-02/archive_and_holds: purpose end is explicit and expiry separates ordinary clinical access', () => {
  const report = signedReport('archive-report');
  const actor = { id: 'reader', kind: 'member', roles: ['radiologist'], canReadStudy: true, canSign: true, canCancel: true };
  const step = (facts, action, extra = {}) => L.transitionReport(facts, { action, actor, at: t0,
    expectedClaimGeneration: facts.claimGeneration, expectedPublishedVersionId: facts.publishedVersion?.versionId ?? null, ...extra }).facts;
  const started = step(L.newReportFacts(report.recordId, 'study'), 'start');
  const approved = step(started, 'approve', { version: { recordId: report.recordId, versionId: report.parts[0].partId, sha256: report.parts[0].evidence.event.sha256 } });
  const finalized = step(approved, 'finalize', { at: shift(t0, DAY), actor: { ...actor, kind: 'service' } });
  assert.equal(L.reportRetentionAccess(finalized, null, null, { record: report, at: shift(t0, DAY) }).ordinaryClinicalAccess, true);
  const before = clone(finalized);
  const archive = L.archiveFinalizedReport(finalized, { actor, at: shift(t0, DAY), reason: '진료 목적 종료 확인', purpose: 'clinical-purpose-ended',
    expectedPublishedVersionId: finalized.publishedVersion.versionId });
  assert.equal(L.reportRetentionAccess(finalized, archive, null, { record: report, at: shift(t0, DAY) }).ordinaryClinicalAccess, false);
  assert.equal(L.reportRetentionAccess(finalized, null, null, { record: report, at: D.retentionDeadline(report) }).ordinaryClinicalAccess, false);
  assert.deepEqual(finalized, before, 'separation preserves the signed original');
  const afterExpiry = stored('report-version', report.recordId, 'too-late', D.retentionDeadline(report), { event: { act: 'additional-entry', predecessor: component(report) } });
  assert.throws(() => D.recordVersionAdded(report, afterExpiry, snapshotFor([report], afterExpiry.event.at)), 'expiry cannot authorize a new clinical part');
});

if (process.env.KIN_EMR_H_LIST_CASES) process.stdout.write(JSON.stringify(declaredCases, null, 2) + '\n');
