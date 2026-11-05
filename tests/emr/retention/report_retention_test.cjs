/* CD-09-D pure tests: A's decision for one native report at the end of its retention (decideReport), from the facts the
 * destruction transaction reads (the same shape readReportFacts returns). No database: what the transaction locks,
 * deletes and judges, the gate and the ledger binding are tests/emr/retention/report_retention_pg_test.cjs.
 *
 * Conditions (order-cd-09d-plan-20261105.md, reduced): D1 only an expired, unheld, readable signed report is destroyed and
 * everything else is kept with a reason; D3 the common commit judgement's answers decide completed / failed / started;
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
M.composeEmrAdapters(CTX.runtimeAdapters);

const UID = '2.25.990077', SIGNED = '2020-03-10T02:00:00.000Z';
// The statutory boundary the law sets for that signature: 5 civil years from its Seoul day (규칙 제15조①, D-21).
const DEADLINE = D.civilPeriodEnd(SIGNED, 5);
const shift = (at, ms) => new Date(Date.parse(at) + ms).toISOString();
const DAY = 86_400_000;
const hex = n => n.toString(16).padStart(64, '0');

function version(v, action, patch = {}) {
  return { version: v, action, findings: `SYN findings ${v}`, conclusion: 'SYN conclusion', recommendation: '', reason: null,
    author: 'syn-reader@synthetic.test', citations: null, structured: null, ...patch };
}
function signature(v, at = SIGNED, patch = {}) {
  return { recordId: UID, versionId: String(v), versionSha256: hex(v), signedAt: at, operationId: randomUUID(), ...patch };
}
function facts(patch = {}) {
  const versions = patch.versions ?? [version(1, 'approve')];
  return { uid: UID, unit: 'disposal:' + randomUUID(), rs: 'A', versions,
    signatures: patch.signatures ?? new Map(versions.map(v => [String(v.version), signature(v.version)])),
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
    for (const secret of [UID, 'SYN findings', 'syn-reader', hex(1)]) assert.ok(!text.includes(secret), secret);
  }
  assert.equal(after.lines[0].operationId, after.lines[1].operationId);
  assert.equal(after.lines[0].partCount, 1);
});

test('R02 every signed version is a part: the newest signature decides the boundary (an Addendum moves it)', async () => {
  const later = shift(SIGNED, 400 * DAY);
  const versions = [version(1, 'approve'), version(2, 'addendum')];
  const signatures = new Map([['1', signature(1)], ['2', signature(2, later)]]);
  const f = facts({ versions, signatures });
  assert.equal((await decide(f, DEADLINE)).decision.outcome, 'retained');
  const done = await decide(facts({ versions, signatures }), D.civilPeriodEnd(later, 5));
  assert.equal(done.decision.outcome, 'destroyed');
  assert.equal(done.lines[0].partCount, 2);
});

test('R03 a version without the server signature, an unreadable signature or a report that is not approved is kept unconfirmed, nothing recorded', async () => {
  const at = shift(DEADLINE, 30 * DAY);
  const unsigned = facts({ versions: [version(1, 'save'), version(2, 'approve')], signatures: new Map([['2', signature(2)]]) });
  const unreadable = facts({ signatures: new Map([['1', signature(1, 'not a time')]]) });
  const foreign = facts({ signatures: new Map([['1', signature(1, SIGNED, { recordId: '2.25.1' })]]) });
  const reset = facts({ rs: 'W' });
  const none = facts({ versions: [], signatures: new Map() });
  for (const [f, code] of [[unsigned, 'unsigned-version'], [unreadable, 'signature-unreadable'], [foreign, 'signature-unreadable'],
      [reset, 'not-approved'], [none, 'no-version']]) {
    const out = await decide(f, at);
    assert.deepEqual(out.decision, { outcome: 'unconfirmed', code, deadline: null }, code);
    assert.deepEqual(out.lines, []); assert.equal(out.deleted, 0);
  }
});

test('R04 versions whose signatures do not run forward in time are not a record A accepts: unconfirmed, nothing recorded', async () => {
  const versions = [version(1, 'approve'), version(2, 'addendum')];
  const out = await decide(facts({ versions, signatures: new Map([['1', signature(1, shift(SIGNED, DAY))], ['2', signature(2)]]) }),
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
