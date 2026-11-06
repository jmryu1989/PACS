/* CD-09-D pure tests: A's decision for one native report at the end of its retention (decideReport), from the facts the
 * destruction transaction reads (the same shape readReportFacts returns). No database: what the transaction locks,
 * deletes and judges, the gate and the ledger binding are tests/emr/retention/report_retention_pg_test.cjs (R12-R13 run the
 * gate's mirror binding and restore against a double of the anchor row alone).
 *
 * Conditions (order-cd-09d-plan-20261105.md, reduced): D1 only an expired, unheld, readable signed report is destroyed and
 * everything else is kept with a reason (readable: each stored envelope verified under its retained key, the period counted
 * from the envelope's signed time; review F1 → R09; the stored version equal to the signed row, its citations and structured
 * items by value; review r2 F1 → R10); D3 the common commit judgement's answers decide completed / failed / started;
 * D4 each attempt's record names its due day and a late one is overdue; D6/D8 a reference or a draft keeps the report.
 *
 * Assertions are on behaviour (the outcome, its code, ledger lines written or not, the deletion called or not) and on the
 * contract fields of the destruction record; never on implementation strings. Synthetic data only.
 */
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..', '..');
const api = path.join(root, 'api');
const ts = require(path.join(api, 'node_modules/typescript'));
const config = ts.readConfigFile(path.join(api, 'tsconfig.json'), ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, api);
require.extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'),
  { compilerOptions: parsed.options, fileName: filename }).outputText, filename);
const M = require(path.join(api, 'src/emr-contract/composition.ts'));
const CTX = require(path.join(api, 'src/emr-runtime/context.ts'));
const D = require(path.join(api, 'src/emr-contract/lawful-defaults.ts'));
const J = require(path.join(api, 'src/emr-retention/commit-judgement.ts'));
const R = require(path.join(api, 'src/emr-retention/report-retention.ts'));
const C = require(path.join(api, 'src/emr-signature/server-crypto.ts'));
M.composeEmrAdapters(CTX.runtimeAdapters);

const UID = '2.25.990077', SIGNED = '2020-03-10T02:00:00.000Z';
// The statutory boundary the law sets for that signature: 5 civil years from its Seoul day (규칙 제15조①, D-21).
const DEADLINE = D.civilPeriodEnd(SIGNED, 5);
const shift = (at, ms) => new Date(Date.parse(at) + ms).toISOString();
const DAY = 86_400_000;
const hex = n => n.toString(16).padStart(64, '0');

function version(v, action, patch = {}) {
  return { id: 100 + v, version: v, action, findings: `SYN findings ${v}`, conclusion: 'SYN conclusion', recommendation: '', reason: null,
    author: 'syn-reader@synthetic.test', citations: null, structured: null, at: SIGNED, ...patch };
}

// A real stored approval (emr-report/native-signing.ts → online-store.ts): the current signServerPayload over the whole
// version, the signing time taken from the clock as the product does (the clock is set to `at` only while it signs), and
// the key registration retained beside it. A summary-only object is not a signature the product ever stores.
const KEYS = C.generateServerKeyPair();
const SIGNER = { issuer: 'SYN', subject: 'syn-reader', id: 'syn-reader@synthetic.test' };
const KEY = { kid: 'SYN-KID', publicKey: KEYS.publicKey, status: 'active', registeredAt: '2010-01-01T00:00:00.000Z', endedAt: null,
  doctor: { identity: SIGNER, identityRegistrationId: 'SYN-REG', institutionId: 'SYN-SITE', canSign: true } };
const SIGNING_ACTION = { approve: 'approve-sign', addendum: 'addendum', reset: 'cancel', save: 'approve-sign' };
function signature(row, at = SIGNED, patch = {}, uid = UID) {
  const content = { formatVersion: 'emr-signature/1', text: { kind: 'clinical-entry', body: JSON.stringify({ uid, ...row }) },
    patient: { linkId: 'SYN-LINK', patientId: 'SYN-PATIENT', assigningAuthority: 'SYN-SITE' }, studyId: uid,
    managingInstitutionId: 'SYN-SITE', actingInstitutionId: 'SYN-SITE', recordKind: 'report-version', recordId: uid,
    versionId: String(row.version), author: SIGNER, signer: SIGNER, identityRegistrationId: 'SYN-REG', action: SIGNING_ACTION[row.action],
    previousVersion: row.version > 1 ? { recordId: uid, versionId: String(row.version - 1), sha256: hex(row.version - 1) } : null,
    attachments: [], reason: row.reason ?? null };
  test.mock.timers.enable({ apis: ['Date'], now: Date.parse(at) });
  let signed;
  try { signed = C.signServerPayload(content, KEY.kid, KEYS.privateKey); } finally { test.mock.timers.reset(); }
  return { ...signed, operationId: randomUUID(), recordId: UID, versionId: String(row.version), kid: KEY.kid, doctorId: SIGNER.id,
    institutionId: 'SYN-SITE', keyAtSigning: KEY, ...patch };
}
function facts(patch = {}) {
  const versions = patch.versions ?? [version(1, 'approve')];
  return { uid: UID, unit: 'disposal:' + randomUUID(), rs: 'A', versions,
    signatures: patch.signatures ?? new Map(versions.map(v => [String(v.version), signature(v)])),
    holds: [], accessRequests: new Map(), correctionRequests: new Map(), clauseVersions: new Map(), references: [], ...patch };
}
function journal() {
  const lines = [];
  return { lines, append: async event => { lines.push(structuredClone(event)); return { durableAt: '2099-01-01T00:00:00.000Z' }; } };
}
async function decide(f, at, destroy) {
  const store = journal(); let deleted = 0;
  try {
    const decision = await R.decideReport(store, f, at, destroy ?? (async () => { deleted++; return { completedAt: at, method: 'operational-store-deletion' }; }));
    return { decision, lines: store.lines, deleted };
  } catch (error) { return { error, lines: store.lines, deleted }; }
}

// ── D1: only an expired, unheld report the product can read as a signed record is destroyed ──

test('R01 the day before the statutory boundary the report is retained; from the boundary it is destroyed with started then completed', async () => {
  const before = await decide(facts(), shift(DEADLINE, -DAY));
  assert.equal(before.decision.outcome, 'retained');
  assert.deepEqual(before.lines, []); assert.equal(before.deleted, 0);
  const just = await decide(facts(), shift(DEADLINE, -1));
  assert.equal(just.decision.outcome, 'retained');
  const f = facts(), after = await decide(f, DEADLINE);
  assert.equal(after.decision.outcome, 'destroyed');
  assert.equal(after.deleted, 1);
  assert.deepEqual(after.lines.map(l => l.phase), ['started', 'completed']);
  for (const line of after.lines) {
    assert.equal(line.disposalUnitId, f.unit);
    assert.equal(line.method, 'operational-store-deletion');
    // No study, version, author or text reaches the ledger.
    const text = JSON.stringify(line);
    for (const secret of [UID, 'SYN findings', 'syn-reader', f.signatures.get('1').versionSha256]) assert.ok(!text.includes(secret), secret);
  }
  assert.equal(after.lines[0].operationId, after.lines[1].operationId);
  assert.equal(after.lines[0].partCount, 1);
});

test('R02 every signed version is a part: the newest signature decides the boundary (an Addendum moves it)', async () => {
  const later = shift(SIGNED, 400 * DAY);
  const versions = [version(1, 'approve'), version(2, 'addendum')];
  const signatures = new Map([['1', signature(versions[0])], ['2', signature(versions[1], later)]]);
  const f = facts({ versions, signatures });
  assert.equal((await decide(f, DEADLINE)).decision.outcome, 'retained');
  const done = await decide(facts({ versions, signatures }), D.civilPeriodEnd(later, 5));
  assert.equal(done.decision.outcome, 'destroyed');
  assert.equal(done.lines[0].partCount, 2);
});

test('R03 a version without the server signature, an unreadable signature, one of another record or text, or a report that is not approved is kept unconfirmed, nothing recorded', async () => {
  const at = shift(DEADLINE, 30 * DAY), v1 = version(1, 'approve');
  const unsignedVersions = [version(1, 'save'), version(2, 'approve')];
  const unsigned = facts({ versions: unsignedVersions, signatures: new Map([['2', signature(unsignedVersions[1])]]) });
  const unreadable = facts({ signatures: new Map([['1', signature(v1, SIGNED, { envelope: { payload: 'not-json' } })]]) });
  // A valid envelope under another key than the one retained at signing is not this server's signature of the version.
  const otherKey = facts({ signatures: new Map([['1', signature(v1, SIGNED, { keyAtSigning: { ...KEY, publicKey: C.generateServerKeyPair().publicKey } })]]) });
  const foreign = facts({ signatures: new Map([['1', signature(v1, SIGNED, {}, '2.25.1')]]) });
  const otherText = facts({ signatures: new Map([['1', signature(version(1, 'approve', { findings: 'SYN other findings' }))]]) });
  const reset = facts({ rs: 'W' });
  const none = facts({ versions: [], signatures: new Map() });
  for (const [f, code] of [[unsigned, 'unsigned-version'], [unreadable, 'signature-unreadable'], [otherKey, 'signature-unreadable'],
      [foreign, 'signature-version-mismatch'], [otherText, 'signature-version-mismatch'], [reset, 'not-approved'], [none, 'no-version']]) {
    const out = await decide(f, at);
    assert.deepEqual(out.decision, { outcome: 'unconfirmed', code, deadline: null }, code);
    assert.deepEqual(out.lines, []); assert.equal(out.deleted, 0);
  }
});

test('R09 F1: the period starts at the time the envelope signed, never the row summary; a summary that disagrees or an envelope that cannot be read keeps the report unconfirmed before any record', async () => {
  // The day before the boundary of the real signature: a summary claiming 2015 would make it look five years past.
  const at = shift(DEADLINE, -DAY), v1 = version(1, 'approve'), OLD = '2015-01-05T01:00:00.000Z';
  const cases = [
    ['signature-summary-mismatch', signature(v1, SIGNED, { signedAt: OLD })],
    ['signature-unreadable', signature(v1, SIGNED, { signedAt: OLD, envelope: { payload: 'not-json' } })],
    ['signature-summary-mismatch', signature(v1, SIGNED, { versionSha256: hex(7) })],
  ];
  for (const [code, stored] of cases) {
    const out = await decide(facts({ signatures: new Map([['1', stored]]) }), at);
    assert.deepEqual(out.decision, { outcome: 'unconfirmed', code, deadline: null }, code);
    assert.deepEqual(out.lines, [], 'no started record'); assert.equal(out.deleted, 0);
  }
  // The same version with its true summary is still within its period that day.
  assert.equal((await decide(facts({ signatures: new Map([['1', signature(v1)]]) }), at)).decision.outcome, 'retained');
});

test('R10 r2 F1: a version whose citations, structured items or other stored column differ from the signed row is kept unconfirmed before any record; the same values in another key order are destroyed', async () => {
  const at = shift(DEADLINE, DAY), LATE = '2026-11-05T00:00:00.000Z';
  const signedRow = version(1, 'approve', {
    citations: [{ v: 2, cid: 'syn-c', field: 'findings', findingId: 'syn-f', findingRevision: 1, sourceIndex: 0, sourceRef: {},
      linkStateAtInsert: 'current', headRevisionAtInsert: 1, insertedText: 'SYN findings 1', insertedAt: SIGNED, insertedBy: SIGNER.id }],
    structured: [{ v: 1, sid: 'syn-s', field: 'findings', templateId: 'GEN-1', templateRevision: 1, itemCode: 'TECHNIQUE',
      valueType: 'text', value: 'SYN', renderedText: 'SYN findings 1', enteredAt: SIGNED, enteredBy: SIGNER.id }] });
  const stored = signature(signedRow);
  const run = row => decide(facts({ versions: [row], signatures: new Map([['1', stored]]) }), at);
  const changed = mutate => { const row = structuredClone(signedRow); mutate(row); return row; };
  // The store hands the JSON back in its own key order: the same values are the same version.
  const reversed = o => Object.fromEntries(Object.entries(o).reverse());
  for (const [name, row] of [['same row', changed(() => {})],
      ['other key order', changed(r => { r.citations = r.citations.map(reversed); r.structured = r.structured.map(reversed); })]]) {
    const out = await run(row);
    assert.equal(out.decision.outcome, 'destroyed', name); assert.equal(out.deleted, 1, name);
    assert.deepEqual(out.lines.map(l => l.phase), ['started', 'completed'], name);
  }
  // Every differing row is decided before the comparison, so a failure names each one that was not kept.
  const kept = { outcome: 'unconfirmed', code: 'signature-version-mismatch', phases: [], deleted: 0 };
  const differing = {
    'structured item': changed(r => { r.structured[0].enteredAt = LATE; r.structured[0].enteredBy = 'syn-other'; }),
    'citation': changed(r => { r.citations[0].findingRevision = 2; r.citations[0].insertedAt = LATE; }),
    'structured gone': changed(r => { r.structured = null; }),
    'findings': changed(r => { r.findings = 'SYN other findings'; }),
    'row time': changed(r => { r.at = LATE; }),
  };
  const decided = {};
  for (const [name, row] of Object.entries(differing)) {
    const out = await run(row);
    decided[name] = { outcome: out.decision.outcome, code: out.decision.code ?? null, phases: out.lines.map(l => l.phase), deleted: out.deleted };
  }
  assert.deepEqual(decided, Object.fromEntries(Object.keys(differing).map(name => [name, kept])));
  // A nullable column the signed row did not carry is the NULL the store keeps for it.
  const { structured: _absent, ...withoutStructured } = version(1, 'approve');
  assert.equal((await decide(facts({ signatures: new Map([['1', signature(withoutStructured)]]) }), at)).decision.outcome, 'destroyed');
});

test('R04 versions whose signatures do not run forward in time are not a record A accepts: unconfirmed, nothing recorded', async () => {
  const versions = [version(1, 'approve'), version(2, 'addendum')];
  const out = await decide(facts({ versions, signatures: new Map([['1', signature(versions[0], shift(SIGNED, DAY))], ['2', signature(versions[1])]]) }),
    shift(DEADLINE, 30 * DAY));
  assert.equal(out.decision.outcome, 'unconfirmed');
  assert.match(out.decision.code, /^record-unresolved:/);
  assert.deepEqual(out.lines, []); assert.equal(out.deleted, 0);
});

const CLAUSE = 'synthetic-law:article-1';
function hold(at, release = null) {
  const placed = { holdId: 'syn-hold-report', recordId: UID, actorId: 'custodian', at, release: null, basis: { type: 'court-order',
    clause: { law: 'synthetic-law', article: 'article-1', version: '2026-v1' }, clauseId: CLAUSE, authorityKind: 'court',
    managingInstitutionId: 'syn-hospital', requestId: 'syn-request', authorityId: 'syn-court', scope: [UID], verified: true,
    validity: { from: at, until: null, condition: 'order-in-force' } } };
  const rows = [{ holdId: placed.holdId, phase: 'placed', body: JSON.stringify(placed) }];
  if (release) rows.push({ holdId: placed.holdId, phase: 'released', body: JSON.stringify({ ...placed, release: { holdId: placed.holdId,
    actorId: 'custodian', at: release, evidenceId: 'syn-ending', authorityVerified: true, reason: 'order-ended' } }) });
  return rows;
}
const clauses = new Map([[CLAUSE, [{ law: 'synthetic-law', article: 'article-1', publication: '2026-v1', publishedAt: '2010-01-01', effectiveAt: '2010-01-01' }]]]);

test('R05 an active legal hold keeps an expired report (held, nothing recorded); its recorded release lets the same report be destroyed', async () => {
  const at = shift(DEADLINE, 10 * DAY), placed = shift(SIGNED, DAY);
  const held = await decide(facts({ holds: hold(placed), clauseVersions: clauses }), at);
  assert.equal(held.decision.outcome, 'held'); assert.equal(held.decision.code, 'legal-hold');
  assert.equal(held.decision.deadline, DEADLINE);
  assert.deepEqual(held.lines, []); assert.equal(held.deleted, 0);
  const released = await decide(facts({ holds: hold(placed, shift(DEADLINE, DAY)), clauseVersions: clauses }), at);
  assert.equal(released.decision.outcome, 'destroyed');
});

// ── D6 / D8: a reference to the report or a draft of the study keeps it ──

test('R06 a question, Related insertion, critical result, attachment, order, live or ended draft keeps the expired report, nothing recorded', async () => {
  const at = shift(DEADLINE, 10 * DAY);
  for (const kind of ['question', 'related', 'critical-result', 'attachment', 'order', 'live-draft', 'ended-draft']) {
    const out = await decide(facts({ references: [kind] }), at);
    assert.deepEqual(out.decision, { outcome: 'held', code: kind, deadline: DEADLINE }, kind);
    assert.deepEqual(out.lines, []); assert.equal(out.deleted, 0);
  }
  // The same report with the reference gone is destroyed.
  assert.equal((await decide(facts({ references: [] }), at)).decision.outcome, 'destroyed');
});

// ── D3: the common commit judgement decides what the ledger says ──

test('R07 a deletion the judgement finds not committed is failed (no completed); an unknown one leaves started only', async () => {
  const at = shift(DEADLINE, DAY);
  const failed = await decide(facts(), at, async () => J.destroyerAnswer('not-committed',
    { completedAt: at, method: 'operational-store-deletion' }, () => Object.assign(new Error('not committed'), { code: 'ReportDeleteNotCommitted' })));
  assert.equal(failed.error?.code, 'ReportDeleteNotCommitted');
  assert.deepEqual(failed.lines.map(l => l.phase), ['started', 'failed']);
  const unknown = await decide(facts(), at, async () => J.destroyerAnswer('unknown',
    { completedAt: at, method: 'operational-store-deletion' }, () => new Error('unreachable')));
  assert.ok(unknown.error instanceof D.CommitOutcomeUnknown);
  assert.deepEqual(unknown.lines.map(l => l.phase), ['started']);
});

// ── D4: the record of each attempt says when it was due and whether it ran late ──

test('R08 an attempt five days after the boundary is within the window; six days after, its completed record is overdue', async () => {
  const within = await decide(facts(), shift(DEADLINE, 4 * DAY));
  assert.equal(within.lines[1].timeliness, 'within-five-days');
  const late = await decide(facts(), shift(DEADLINE, 6 * DAY));
  assert.equal(late.lines[1].timeliness, 'overdue');
  assert.equal(late.lines[1].delayReasonStatus, 'missing');
  assert.equal(late.lines[1].dueDay, R.dueDayOf(DEADLINE));
  // The due day is the fifth civil day counted from the boundary's own Seoul day.
  assert.equal(R.dueDayOf('2025-03-09T15:00:00.000Z'), '2025-03-14');
});

// The ledger mirror (2026-11-06): the report ledger shares the draft purpose ledger's mirror directory setting and is written
// to it with every record; its gate over a real database is report_retention_pg_test.cjs PG11.

test('R11 the report ledger is written to its mirror byte for byte, under the shared setting and the ReportLedger codes', () => {
  const env = { KIN_PURPOSE_LEDGER_DIR: '/var/lib/kin-purpose', KIN_EMR_STATE_DIR: '/var/lib/kin-emr' };
  assert.equal(R.reportLedgerMirrorDirectory(env), null);
  assert.equal(R.reportLedgerMirrorDirectory({ ...env, KIN_LEDGER_MIRROR_DIR: '/var/lib/kin-ledger-mirror' }), '/var/lib/kin-ledger-mirror');
  for (const [mirror, code] of [['relative', 'ReportLedgerMirrorDirectoryRequired'], ['/var/lib/kin-emr', 'ReportLedgerMirrorInsideBackup'],
    ['/var/lib/kin-purpose', 'ReportLedgerMirrorInsideLedger']])
    assert.throws(() => R.reportLedgerMirrorDirectory({ ...env, KIN_LEDGER_MIRROR_DIR: mirror }), e => e.code === code, mirror);
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'cd09d-ledger-'));
  const mirror = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'cd09d-mirror-'));
  const ledger = new R.ReportLedgerFile(dir, undefined, mirror);
  assert.equal(ledger.mirror, path.join(mirror, R.REPORT_LEDGER_FILE));
  const id = randomUUID();
  ledger.create(id);
  assert.deepEqual(fs.readFileSync(ledger.mirror), fs.readFileSync(ledger.file));
  // Without the setting there is one file, as before.
  assert.equal(new R.ReportLedgerFile(dir).mirror, null);
});

// r2 (GPT F1/F2): the gate's binding and restore against a double of the one anchor row (no report rows: nothing to
// re-apply). It answers the statements by their text and applies a transaction's writes only when its callback returns.
function anchorOnly(anchor) {
  const state = { anchor, audit: [], auditFails: 0 };
  const answer = writes => async (strings, ...values) => {
    const text = strings.join('?').replace(/\s+/g, ' ');
    if (/pg_advisory_xact_lock/.test(text)) return 0;
    if (/^SELECT initialized FROM "ReportLedgerAnchor"/.test(text)) return [{ initialized: state.anchor.initialized }];
    if (/FROM "ReportLedgerAnchor"/.test(text)) return [{ ...state.anchor }];
    if (/^UPDATE "ReportLedgerAnchor" SET initialized = true/.test(text)) { writes.push(() => { state.anchor.initialized = true; }); return 1; }
    throw new Error('unexpected statement: ' + text);
  };
  state.db = {
    async $transaction(fn) {
      const writes = [], query = answer(writes);
      const result = await fn({ $queryRaw: query, $executeRaw: query });
      writes.forEach(w => w());
      return result;
    },
    $queryRaw: answer([]),
    auditLog: { create: async ({ data }) => {
      if (state.auditFails > 0) { state.auditFails--; throw new Error('SYN audit insert failed'); }
      state.audit.push(structuredClone(data)); return data;
    } },
  };
  return state;
}
const tmp = prefix => fs.mkdtempSync(path.join(require('node:os').tmpdir(), prefix));

test('R12 r2 F1: a first-start binding whose header the mirror refused stays unbound until a later start finds both places equal', async () => {
  const s = anchorOnly({ ledgerId: randomUUID(), seq: 0, initialized: false, lastCompletedUnit: null, lastCompletedAt: null });
  const dir = tmp('cd09d-ledger-'), mirrorDir = tmp('cd09d-mirror-');
  let failing = true;
  const opened = new Map();
  const io = { ...require(path.join(api, 'src/emr-retention/ledger-file.ts')).nodeLedgerIo,
    openSync: (file, flags, mode) => { const fd = fs.openSync(file, flags, mode); opened.set(fd, file); return fd; },
    writeSync: (fd, buffer, offset, length) => (failing && path.dirname(opened.get(fd)) === mirrorDir ? 0 : fs.writeSync(fd, buffer, offset, length)) };
  const open = () => new R.ReportRetention(s.db, new R.ReportLedgerFile(dir, io, mirrorDir)).openGate();
  await assert.rejects(open(), e => e.code === 'ReportLedgerMirrorWriteFailed', 'the first start');
  const file = path.join(dir, R.REPORT_LEDGER_FILE), mirror = path.join(mirrorDir, R.REPORT_LEDGER_FILE);
  assert.ok(fs.existsSync(file), 'the file took the header');
  assert.equal(s.anchor.initialized, false);
  await assert.rejects(open(), e => e.code === 'ReportLedgerMirrorWriteFailed', 'a start while the mirror still fails');
  assert.equal(s.anchor.initialized, false, 'not bound beside the file alone');
  failing = false;
  assert.deepEqual(await open(), { bound: false, reapplied: 0, units: 0 });
  assert.equal(s.anchor.initialized, true);
  assert.deepEqual(fs.readFileSync(mirror), fs.readFileSync(file));
});

test('R13 r2 F2: a lost report ledger file is restored only after its audit row; an audit row that fails keeps the gate closed and the file lost', async () => {
  const dir = tmp('cd09d-ledger-'), mirrorDir = tmp('cd09d-mirror-'), id = randomUUID();
  new R.ReportLedgerFile(dir, undefined, mirrorDir).create(id);
  const s = anchorOnly({ ledgerId: id, seq: 0, initialized: true, lastCompletedUnit: null, lastCompletedAt: null });
  const file = path.join(dir, R.REPORT_LEDGER_FILE), before = fs.readFileSync(file);
  fs.unlinkSync(file);
  const adapter = () => { const service = new R.ReportRetention(s.db, new R.ReportLedgerFile(dir, undefined, mirrorDir)); return { service, adapter: R.reportRetentionAdapter(() => service) }; };
  s.auditFails = 1;
  const unrecorded = adapter();
  await assert.rejects(unrecorded.adapter.open(), e => e.code === 'ReportLedgerRestoreUnrecorded');
  assert.equal(fs.existsSync(file), false, 'not restored without its record');
  assert.deepEqual(s.audit, []);
  const restored = adapter();
  assert.match(await restored.adapter.open(), /restored from the mirror \(ReportLedgerMissing\)/);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(s.audit.length, 1);
  const [row] = s.audit, detail = JSON.parse(row.detail);
  assert.deepEqual([row.actor, row.action, row.target], ['kin.retention', 'retention.ledger-restore', id]);
  assert.deepEqual([detail.unit, detail.reason, detail.ledgerId, detail.entries, detail.bytes, detail.sha256],
    ['report-retention', 'ReportLedgerMissing', id, 0, before.length, require('node:crypto').createHash('sha256').update(before).digest('hex')]);
});
