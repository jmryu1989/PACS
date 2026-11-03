/* CD-09-P pure tests: a private draft work's purpose end decided by A from the stored facts, the external destruction
 * ledger's closed record shape and durability rules, and the delivery wait that binds a destruction to responses already
 * carrying the draft. No database: the facts a destruction transaction reads are given as rows (the same shapes
 * readPurposeFacts returns); the PostgreSQL and served behaviour is tests/e2e/test_draft_purpose.py.
 *
 * Assertions are on behaviour (allowed outcome or refusal code, ledger lines written or not, waits settled or not) and on
 * the contract fields of DestructionRecord; never on implementation strings. Synthetic data only.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
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
const P = require(path.join(api, 'src/emr-retention/draft-purpose.ts'));
M.composeEmrAdapters(CTX.runtimeAdapters);

const UID = '2.25.990001', AUTHOR = 'syn-reader@synthetic.test', OTHER = 'syn-other@synthetic.test';
const START = '2026-11-01T00:00:00.000Z', END = '2026-11-01T01:00:00.000Z';
const unit = () => 'disposal:' + randomUUID();
const noFacts = () => ({ holds: [], accessRequests: new Map(), correctionRequests: new Map(), clauseVersions: new Map(), signed: null });
function ended(patch = {}) {
  return { disposalUnitId: unit(), uid: UID, author: AUTHOR, workSince: new Date(START), workIntent: 'approve',
    trigger: 'explicit-discard', eventId: randomUUID(), actorId: AUTHOR, endedAt: new Date(END),
    signedRecordId: null, signedVersionId: null, findings: 'SYN private text', conclusion: 'SYN conclusion', recommendation: '',
    baseVersion: 0, citations: null, structured: null, deliverySettled: true, attempts: 0, lastRefusal: null, ...patch };
}
/** An in-memory journal with the ledger's append contract (durable after any synthetic event time). */
function journal() {
  const lines = [];
  return { lines, append: async event => { lines.push(structuredClone(event)); return { durableAt: '2099-01-01T00:00:00.000Z' }; } };
}
async function decide(row, facts = noFacts(), at = '2026-11-01T02:00:00.000Z') {
  const store = journal(); let deleted = 0;
  try {
    const record = await P.decidePurposeEnd(store, row, facts, at, async () => {
      deleted++; return { completedAt: at, method: 'irreversible-permanent-deletion' };
    });
    return { record, lines: store.lines, deleted };
  } catch (error) { return { error: error.code ?? error.message, lines: store.lines, deleted }; }
}
const RECORD_FIELDS = ['basis', 'classes', 'clauseIds', 'day', 'disposalUnitId', 'dueDay', 'expiryDay', 'extensionUsed', 'formatVersion',
  'method', 'partCount', 'phase', 'timeliness'];

// ── A1: only the stored ends of this work, by the right actor, end its purpose ──

test('P01 the author\'s explicit discard of the stored work is destroyed with started then completed, naming only the unit', async () => {
  const row = ended();
  const out = await decide(row);
  assert.equal(out.error, undefined);
  assert.equal(out.deleted, 1);
  assert.deepEqual(out.lines.map(l => l.phase), ['started', 'completed']);
  for (const line of out.lines) {
    assert.deepEqual(Object.keys(line).sort(), RECORD_FIELDS);
    assert.equal(line.disposalUnitId, row.disposalUnitId);
    // No study, author, version, text or text digest reaches the operational ledger.
    const text = JSON.stringify(line);
    for (const secret of [UID, AUTHOR, 'SYN private text', row.eventId]) assert.ok(!text.includes(secret), secret);
  }
  assert.equal(out.lines[0].day, '2026-11-01');
  assert.equal(out.lines[1].timeliness, 'within-five-days');
});

test('P02 a discard recorded as another member\'s act is refused before any record or deletion', async () => {
  const out = await decide(ended({ actorId: OTHER }));
  assert.equal(out.error, 'PurposeOwnerRefused');
  assert.deepEqual(out.lines, []); assert.equal(out.deleted, 0);
});

test('P03 an end not after the work started is refused (no synthesized order)', async () => {
  const out = await decide(ended({ endedAt: new Date(START) }));
  assert.equal(out.error, 'PurposeBindingRefused');
  assert.deepEqual(out.lines, []); assert.equal(out.deleted, 0);
});

test('P04 a signed result ends the work only with the server\'s signature row of that exact version and action', async () => {
  const base = { trigger: 'result-version-signed', signedRecordId: UID, signedVersionId: '3', workIntent: 'approve' };
  const signed = (patch = {}) => ({ ...noFacts(), signed: { outcome: { recordId: UID, versionId: '3', signedAt: END, ...patch.outcome }, action: patch.action ?? 'approve' } });
  const ok = await decide(ended(base), signed());
  assert.equal(ok.error, undefined); assert.equal(ok.deleted, 1);
  // No signature row read: the end row alone is not evidence of a signed result.
  assert.equal((await decide(ended(base), noFacts())).error, 'EmrContextRecordMissing');
  // The signature row names another version, another time or another action.
  assert.equal((await decide(ended(base), signed({ outcome: { versionId: '4' } }))).error, 'EmrContextRecordMissing');
  assert.equal((await decide(ended(base), signed({ outcome: { signedAt: '2026-11-01T01:00:00.001Z' } }))).error, 'PurposeBindingRefused');
  assert.equal((await decide(ended(base), signed({ action: 'addendum' }))).error, 'PurposeBindingRefused');
  // A signed result of a work written for an Addendum must be that Addendum.
  assert.equal((await decide(ended({ ...base, workIntent: 'addendum' }), signed())).error, 'PurposeBindingRefused');
  for (const out of [await decide(ended(base), noFacts())]) { assert.deepEqual(out.lines, []); assert.equal(out.deleted, 0); }
});

test('P05 S2 (정모 님 11-03): another member\'s approval or a parent cancellation is not an end; a result signed by another is not the author\'s end', async () => {
  const out = await decide(ended({ trigger: 'intent-superseded' }));
  assert.equal(out.error, 'PurposeBindingRefused');
  assert.deepEqual(out.lines, []); assert.equal(out.deleted, 0);
  const signedFacts = { ...noFacts(), signed: { outcome: { recordId: UID, versionId: '3', signedAt: END }, action: 'approve' } };
  const foreign = await decide(ended({ trigger: 'result-version-signed', signedRecordId: UID, signedVersionId: '3', actorId: OTHER }), signedFacts);
  assert.equal(foreign.error, 'PurposeOwnerRefused');
  assert.deepEqual(foreign.lines, []); assert.equal(foreign.deleted, 0);
  assert.throws(() => CTX.withSnapshot(CTX.transactionScope(), CTX.snapshotFromRows(CTX.transactionScope(), {
    holds: new Map(), accessRequests: new Map(), correctionRequests: new Map(), clauseVersions: new Map(), accessEvents: new Map() }), () => 1),
    /EmrContextTransactionMismatch/);
});

// ── A2: a live hold on the draft record keeps the payload; its recorded release lets the same end proceed ──

const CLAUSE = 'synthetic-law:article-1';
function hold(recordId, at, release = null) {
  const placed = { holdId: 'syn-hold-' + recordId.length, recordId, actorId: 'custodian', at, release: null, basis: { type: 'court-order',
    clause: { law: 'synthetic-law', article: 'article-1', version: '2026-v1' }, clauseId: CLAUSE, authorityKind: 'court',
    managingInstitutionId: 'syn-hospital', requestId: 'syn-request', authorityId: 'syn-court', scope: [recordId], verified: true,
    validity: { from: at, until: null, condition: 'order-in-force' } } };
  const rows = [{ holdId: placed.holdId, phase: 'placed', body: JSON.stringify(placed) }];
  if (release) rows.push({ holdId: placed.holdId, phase: 'released', body: JSON.stringify({ ...placed, release: { holdId: placed.holdId,
    actorId: 'custodian', at: release, evidenceId: 'syn-ending', authorityVerified: true, reason: 'order-ended' } }) });
  return rows;
}
const clauses = new Map([[CLAUSE, [{ law: 'synthetic-law', article: 'article-1', publication: '2026-v1', publishedAt: '2026-01-01', effectiveAt: '2026-01-01' }]]]);

test('P06 a live hold on the author\'s draft record refuses destruction with zero records; its release lets it proceed', async () => {
  const row = ended(), recordId = P.draftRecordId(row.uid, row.author);
  const held = await decide(row, { ...noFacts(), holds: hold(recordId, '2026-11-01T00:30:00.000Z'), clauseVersions: clauses });
  assert.equal(held.error, 'LegalHoldActive');
  assert.deepEqual(held.lines, []); assert.equal(held.deleted, 0);
  const released = await decide(row, { ...noFacts(), holds: hold(recordId, '2026-11-01T00:30:00.000Z', '2026-11-01T01:30:00.000Z'), clauseVersions: clauses });
  assert.equal(released.error, undefined); assert.equal(released.deleted, 1);
  // The release, not the end, is when the destruction became due.
  assert.equal(released.lines[0].phase, 'started');
  // A hold whose basis cannot be verified from what the transaction read is never read as "no hold".
  const unread = await decide(row, { ...noFacts(), holds: hold(recordId, '2026-11-01T00:30:00.000Z') });
  assert.ok(unread.error); assert.deepEqual(unread.lines, []); assert.equal(unread.deleted, 0);
  // Another author's hold does not hold this work, and this work's hold does not hold another's.
  const other = await decide(ended({ author: OTHER, actorId: OTHER }), { ...noFacts() });
  assert.equal(other.error, undefined);
});

test('P07 a failed deletion is recorded failed after started and the payload is not reported destroyed', async () => {
  const store = journal();
  await assert.rejects(P.decidePurposeEnd(store, ended(), noFacts(), '2026-11-01T02:00:00.000Z', async () => { throw new Error('disk'); }), /disk/);
  assert.deepEqual(store.lines.map(l => l.phase), ['started', 'failed']);
  const unavailable = { append: async () => { throw new Error('ledger down'); } };
  let deleted = 0;
  await assert.rejects(P.decidePurposeEnd(unavailable, ended(), noFacts(), '2026-11-01T02:00:00.000Z', async () => { deleted++; return {}; }),
    e => e.code === 'DestructionJournalUnavailable');
  assert.equal(deleted, 0, 'no deletion before a durable started record');
});

test('P08 the operating window: a destruction after the fifth Seoul day is completed but marked overdue', async () => {
  const out = await decide(ended(), noFacts(), '2026-11-08T02:00:00.000Z');
  assert.equal(out.error, undefined);
  assert.equal(out.lines[1].timeliness, 'overdue');
  // D-21: the end's own Seoul day is the first of the five (11-01 .. 11-05).
  assert.equal(out.lines[1].dueDay, '2026-11-05');
});

// ── the external ledger file ──

function ledgerDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cd09p-ledger-')); }
const sample = (patch = {}) => ({ formatVersion: 1, phase: 'started', day: '2026-11-01', disposalUnitId: unit(), classes: [], clauseIds: ['privacy:21.1'],
  partCount: 1, expiryDay: '2026-11-01', extensionUsed: false, dueDay: '2026-11-06', timeliness: 'within-five-days',
  method: 'irreversible-permanent-deletion', basis: 'privacy-act-21-and-decree-16-1-1', ...patch });

test('P09 the ledger is created by its first append with the database\'s ledger ID and reads back in order', () => {
  const dir = ledgerDir(), ledger = new P.PurposeLedgerFile(dir), id = randomUUID();
  assert.equal(ledger.read(), null);
  const a = sample(), b = sample({ phase: 'completed', disposalUnitId: a.disposalUnitId });
  assert.equal(ledger.append(id, a).seq, 1);
  assert.equal(ledger.append(id, b).seq, 2);
  const view = ledger.read();
  assert.equal(view.ledgerId, id);
  assert.deepEqual(view.entries.map(e => [e.seq, e.record.phase, e.record.disposalUnitId]), [[1, 'started', a.disposalUnitId], [2, 'completed', a.disposalUnitId]]);
  assert.throws(() => ledger.append(randomUUID(), sample()), e => e.code === 'PurposeLedgerMismatch');
  assert.equal(ledger.read().entries.length, 2, 'a refused append writes nothing');
});

test('P10 a record carrying anything but the destruction facts is refused before it is written', () => {
  const dir = ledgerDir(), ledger = new P.PurposeLedgerFile(dir), id = randomUUID();
  ledger.append(id, sample());
  const before = fs.readFileSync(ledger.file);
  for (const bad of [{ ...sample(), uid: UID }, { ...sample(), disposalUnitId: UID }, { ...sample(), phase: 'reapplied' }])
    assert.throws(() => ledger.append(id, bad), e => e.code === 'PurposeLedgerRecordInvalid');
  assert.deepEqual(fs.readFileSync(ledger.file), before);
});

test('P11 a partial last line, an edited line or a renumbered line makes the ledger unreadable (never repaired here)', () => {
  const id = randomUUID();
  const cases = [
    file => fs.appendFileSync(file, '{"kind":"entry"'),
    file => fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"seq":2', '"seq":3')),
    file => fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"phase":"started"', '"phase":"started","note":"x"')),
  ];
  for (const damage of cases) {
    const ledger = new P.PurposeLedgerFile(ledgerDir());
    ledger.append(id, sample()); ledger.append(id, sample());
    damage(ledger.file);
    assert.throws(() => ledger.read(), e => /^PurposeLedger/.test(e.code));
    assert.throws(() => ledger.append(id, sample()), e => /^PurposeLedger/.test(e.code));
  }
});

test('P12 the ledger directory is the deployment\'s own and outside the backed-up EMR state; it is never guessed', () => {
  assert.equal(P.purposeLedgerDirectory({ KIN_PURPOSE_LEDGER_DIR: '/var/lib/kin-purpose', KIN_EMR_STATE_DIR: '/var/lib/kin-emr' }), '/var/lib/kin-purpose');
  // F4: no fallback into the EMR state (that volume is in every backup and would come back with an older database).
  assert.throws(() => P.purposeLedgerDirectory({ KIN_EMR_STATE_DIR: '/state' }), e => e.code === 'PurposeLedgerDirectoryRequired');
  for (const inside of ['/var/lib/kin-emr', '/var/lib/kin-emr/purpose-ledger'])
    assert.throws(() => P.purposeLedgerDirectory({ KIN_PURPOSE_LEDGER_DIR: inside, KIN_EMR_STATE_DIR: '/var/lib/kin-emr' }),
      e => e.code === 'PurposeLedgerInsideBackup', inside);
  assert.equal(P.purposeLedgerDirectory({ KIN_PURPOSE_LEDGER_DIR: '/var/lib/kin-emr-purpose', KIN_EMR_STATE_DIR: '/var/lib/kin-emr' }), '/var/lib/kin-emr-purpose');
  assert.throws(() => P.purposeLedgerDirectory({}), e => e.code === 'PurposeLedgerDirectoryRequired');
  assert.throws(() => P.purposeLedgerDirectory({ KIN_PURPOSE_LEDGER_DIR: 'relative' }), e => e.code === 'PurposeLedgerDirectoryRequired');
  assert.throws(() => new P.PurposeLedgerFile('relative'), e => e.code === 'PurposeLedgerDirectoryRequired');
});

// ── S6: delivery of content read before the end ──

function exchange() {
  const request = new EventEmitter(), response = new EventEmitter();
  response.writableFinished = false; response.destroyed = false;
  return { request, response };
}
const state = promise => Promise.race([promise.then(() => 'settled'), new Promise(r => setImmediate(() => r('waiting')))]);

test('P13 a destruction waits for the author\'s responses registered before it, not for later ones or other authors', async () => {
  const deliveries = new P.DraftDeliveries();
  const first = exchange(), other = exchange();
  deliveries.track(AUTHOR, first.request, first.response);
  deliveries.track(OTHER, other.request, other.response);
  const waiting = deliveries.settled(AUTHOR);
  const later = exchange();
  deliveries.track(AUTHOR, later.request, later.response);
  assert.equal(await state(waiting), 'waiting');
  first.response.emit('finish');
  assert.equal(await state(waiting), 'settled', 'the later response and the other author are not awaited');
  assert.equal(deliveries.pending(AUTHOR), 1);
  later.request.emit('aborted');
  await new Promise(r => setImmediate(r));
  assert.equal(deliveries.pending(AUTHOR), 0);
  // A closed connection settles like a finished one; a handler called without a response registers nothing.
  const cut = exchange();
  deliveries.track(AUTHOR, cut.request, cut.response);
  const second = deliveries.settled(AUTHOR);
  cut.response.emit('close');
  assert.equal(await state(second), 'settled');
  deliveries.track(AUTHOR, {}, undefined);
  assert.equal(await state(deliveries.settled(AUTHOR)), 'settled');
});

// ── F3/F4/F5: the destruction service against a transaction double of the database ──
//
// The double answers the statements the service sends (by their text) from one in-memory state and applies a
// transaction's writes only when its callback returns: a failing commit (commitFails) leaves the state as it was, as
// PostgreSQL does. No SQL engine: the PostgreSQL behaviour of the same paths is tests/e2e/test_draft_purpose.py.

function database(state) {
  const sql = strings => strings.join('?').replace(/\s+/g, ' ');
  const view = s => ({ ...s.anchor });
  function handle(text, values, writes, mode) {
    if (/pg_advisory_xact_lock/.test(text)) { state.log.push(/hashtextextended/.test(text) ? 'hold-lock' : 'ledger-lock'); return mode === 'q' ? [] : 0; }
    if (/AS any/.test(text)) return [{ any: state.works }];
    if (/AS "left"/.test(text)) return [{ left: [...state.ended.keys()].filter(unit => values[0].includes(unit)).length }];
    if (/FROM "PurposeLedgerAnchor"/.test(text) && /^SELECT initialized/.test(text)) return [{ initialized: state.anchor.initialized }];
    if (/FROM "PurposeLedgerAnchor"/.test(text)) return [view(state)];
    if (/SELECT \* FROM "ReportDraftPurposeEnd"/.test(text)) return state.ended.has(values[0]) ? [structuredClone(state.ended.get(values[0]))] : [];
    if (/SELECT 1 (AS present )?FROM "ReportDraftPurposeEnd"/.test(text)) return state.ended.has(values[0]) ? [{ present: 1 }] : [];
    if (/SELECT "disposalUnitId"/.test(text)) {
      const rows = [...state.ended.values()].filter(r => !/WHERE "deliverySettled"/.test(text) || r.deliverySettled);
      return rows.map(r => ({ disposalUnitId: r.disposalUnitId, author: r.author, deliverySettled: r.deliverySettled }));
    }
    if (/emr_access.holds_for/.test(text)) { state.log.push('holds'); return []; }
    if (/^DELETE FROM "ReportDraftPurposeEnd"/.test(text)) { const n = state.ended.has(values[0]) ? 1 : 0; writes.push(s => s.ended.delete(values[0])); return n; }
    if (/^UPDATE "PurposeLedgerAnchor" SET seq/.test(text)) {
      writes.push(s => Object.assign(s.anchor, { seq: values[0], initialized: true, lastCompletedUnit: values[1], lastCompletedAt: values[2] }));
      return 1;
    }
    if (/^UPDATE "PurposeLedgerAnchor" SET initialized/.test(text)) { writes.push(s => { s.anchor.initialized = true; }); return 1; }
    if (/^UPDATE "ReportDraftPurposeEnd" SET "deliverySettled" = true WHERE "disposalUnitId"/.test(text)) {
      if (state.settleFails-- > 0) throw Object.assign(new Error('SYN connection lost'), { code: 'P1017' });
      writes.push(s => { const r = s.ended.get(values[0]); if (r) r.deliverySettled = true; }); return 1;
    }
    if (/^UPDATE "ReportDraftPurposeEnd" SET "deliverySettled" = true WHERE NOT/.test(text)) { writes.push(s => s.ended.forEach(r => { r.deliverySettled = true; })); return 0; }
    if (/^UPDATE "ReportDraftPurposeEnd" SET attempts/.test(text)) { writes.push(s => { const r = s.ended.get(values[2] ?? values[1]); if (r) r.attempts++; }); return 1; }
    if (/^UPDATE "ReportDraft" SET present = false/.test(text)) return 0;
    throw new Error('unexpected statement: ' + text);
  }
  const client = writes => ({
    $queryRaw: async (strings, ...values) => handle(sql(strings), values, writes, 'q'),
    $executeRaw: async (strings, ...values) => handle(sql(strings), values, writes, 'x'),
  });
  const db = {
    async $transaction(fn) {
      const writes = [];
      const result = await fn(client(writes));
      if (writes.length && state.commitFails > 0) { state.commitFails--; throw new Error('SYN COMMIT FAILURE; transaction rolled back'); }
      // What the served stack showed: COMMIT failed in PostgreSQL and the client still saw a resolved transaction.
      if (writes.length && state.silentCommitFails > 0) { state.silentCommitFails--; return result; }
      writes.forEach(w => w(state));
      return result;
    },
  };
  // Outside a transaction a statement commits on its own.
  const autocommit = mode => async (strings, ...values) => {
    const writes = [], result = handle(sql(strings), values, writes, mode);
    writes.forEach(w => w(state)); return result;
  };
  db.$queryRaw = autocommit('q');
  db.$executeRaw = autocommit('x');
  return db;
}
function stateWith(rows, anchor = {}) {
  return { anchor: { ledgerId: randomUUID(), seq: 0, initialized: true, lastCompletedUnit: null, lastCompletedAt: null, ...anchor },
    ended: new Map(rows.map(r => [r.disposalUnitId, r])), works: true, log: [], commitFails: 0, silentCommitFails: 0, settleFails: 0 };
}
const NOW = () => new Date('2026-11-01T02:00:00.000Z');
/** A ledger file holding only its header for this database (the file format is the contract; written here directly). */
function ledgerFor(ledgerId) {
  const ledger = new P.PurposeLedgerFile(ledgerDir());
  fs.writeFileSync(ledger.file, JSON.stringify({ kind: 'header', formatVersion: 1, ledgerId, createdAt: '2026-11-01T00:00:00.000Z' }) + '\n');
  return ledger;
}

test('P14 F3: completed is written only after the deletion committed; a failed commit is failed and the payload stays', async () => {
  const row = ended(), state = stateWith([row]);
  const ledger = ledgerFor(state.anchor.ledgerId);
  state.commitFails = 1;
  const service = new P.DraftPurposeDisposal(database(state), ledger, null, NOW);
  await assert.rejects(service.destroy(row.disposalUnitId), /SYN COMMIT FAILURE/);
  assert.deepEqual(ledger.read().entries.map(e => e.record.phase), ['started', 'failed']);
  assert.ok(state.ended.has(row.disposalUnitId), 'the rolled-back deletion left the payload');
  assert.equal(state.anchor.seq, 0);
  // The holds were read only under the record's hold lock.
  assert.ok(state.log.indexOf('hold-lock') >= 0 && state.log.indexOf('hold-lock') < state.log.indexOf('holds'), state.log.join());
  // A COMMIT that fails while the transaction still resolves for the client: the row decides, so it is failed too.
  state.silentCommitFails = 1;
  await assert.rejects(service.destroy(row.disposalUnitId), e => e.code === 'PurposeDeleteNotCommitted');
  assert.deepEqual(ledger.read().entries.map(e => e.record.phase), ['started', 'failed', 'started', 'failed']);
  assert.ok(state.ended.has(row.disposalUnitId));
  // The next attempt commits: completed follows its own started, and the anchor names the completion.
  const done = await service.destroy(row.disposalUnitId);
  assert.equal(done.outcome, 'destroyed');
  const phases = ledger.read().entries.map(e => e.record.phase);
  assert.deepEqual(phases, ['started', 'failed', 'started', 'failed', 'started', 'completed']);
  assert.equal(state.anchor.seq, 6);
  assert.equal(state.anchor.lastCompletedUnit, row.disposalUnitId);
  assert.ok(!state.ended.has(row.disposalUnitId));
});

test('P15 F3: a completion lost between the commit and its record is written at the next match with its original time', async () => {
  const row = ended(), state = stateWith([row]);
  const ledger = ledgerFor(state.anchor.ledgerId);
  await new P.DraftPurposeDisposal(database(state), ledger, null, NOW).destroy(row.disposalUnitId);
  const whole = fs.readFileSync(ledger.file, 'utf8').split('\n');
  const completedLine = JSON.parse(whole[whole.length - 2]);
  // The stop: the file loses its last record (completed); the database kept the commit.
  fs.writeFileSync(ledger.file, whole.slice(0, -2).join('\n') + '\n');
  const later = () => new Date('2026-11-20T00:00:00.000Z');
  const out = await new P.DraftPurposeDisposal(database(state), ledger, null, later).openGate();
  assert.deepEqual(out, { reapplied: 0, units: 1, resolved: 0 });
  const last = ledger.read().entries.at(-1);
  assert.deepEqual([last.seq, last.record], [completedLine.seq, completedLine.record], 'the original completion facts, not a new day');
  // Anything else shorter than the database saw stays closed.
  fs.writeFileSync(ledger.file, whole.slice(0, -3).join('\n') + '\n');
  await assert.rejects(new P.DraftPurposeDisposal(database(state), ledger, null, later).openGate(), e => e.code === 'PurposeLedgerBehind');
});

test('P16 F4: a copy that ever handed out a work never opens without its ledger, even before any destruction (seq 0)', async () => {
  const missing = new P.PurposeLedgerFile(path.join(ledgerDir(), 'absent'));
  const initialized = stateWith([], { seq: 0, initialized: true });
  await assert.rejects(new P.DraftPurposeDisposal(database(initialized), missing, null, NOW).openGate(), e => e.code === 'PurposeLedgerMissing');
  // A copy that never held a work opens without creating anything.
  const fresh = stateWith([], { initialized: false }); fresh.works = false;
  assert.deepEqual(await new P.DraftPurposeDisposal(database(fresh), missing, null, NOW).openGate(), { reapplied: 0, units: 0, resolved: 0 });
  assert.equal(missing.read(), null); assert.equal(fresh.anchor.initialized, false);
  // A copy whose drafts the migration numbered gets its ledger before it opens, and is initialized from then on.
  const numbered = stateWith([], { initialized: false });
  await new P.DraftPurposeDisposal(database(numbered), missing, null, NOW).openGate();
  assert.equal(missing.read().ledgerId, numbered.anchor.ledgerId);
  assert.equal(numbered.anchor.initialized, true);
  // The first work handed out through the server writes the ledger first, then the database's flag (same transaction).
  const first = stateWith([], { initialized: false }), firstLedger = new P.PurposeLedgerFile(path.join(ledgerDir(), 'first'));
  const db = database(first);
  await db.$transaction(tx => new P.DraftPurposeDisposal(db, firstLedger, null, NOW).ensureLedger(tx));
  assert.equal(firstLedger.read().ledgerId, first.anchor.ledgerId);
  assert.equal(first.anchor.initialized, true);
});

test('P17 F5: the sweep run reports a work whose delivery is not settled and is not complete; the server settles and retries', async () => {
  const row = ended({ deliverySettled: false }), state = stateWith([row]);
  const ledger = ledgerFor(state.anchor.ledgerId);
  const results = await new P.DraftPurposeDisposal(database(state), ledger, null, NOW).sweep();
  assert.deepEqual(results, [{ unit: row.disposalUnitId, outcome: 'delivery-pending' }]);
  const S = require(path.join(api, 'src/emr-retention/draft-purpose-sweep.ts'));
  const report = await S.runDraftPurposeSweep(database(state), ledger.directory);
  assert.equal(report.complete, false);
  assert.ok(state.ended.has(row.disposalUnitId));
  // The server: its settle step fails once (a lost connection) and is retried; the work is then destroyed.
  state.settleFails = 1;
  const service = new P.DraftPurposeDisposal(database(state), ledger, new P.DraftDeliveries(), NOW);
  const errors = [], original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    service.scheduleDestruction(row.disposalUnitId, row.author);
    const deadline = Date.now() + 5000;
    while (state.ended.has(row.disposalUnitId) && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
  } finally { console.error = original; }
  assert.ok(!state.ended.has(row.disposalUnitId), errors.join('\n'));
  assert.ok(errors.some(e => /retry 1/.test(e)), errors.join('\n'));
  assert.deepEqual(ledger.read().entries.map(e => e.record.phase), ['started', 'completed']);
});
