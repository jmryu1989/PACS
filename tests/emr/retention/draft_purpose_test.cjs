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
      deleted++; return { completedAt: at, method: 'operational-store-deletion' };
    });
    return { record, lines: store.lines, deleted };
  } catch (error) { return { error: error.code ?? error.message, lines: store.lines, deleted }; }
}
// CD-09-C: the record every new attempt writes (format 2). Format 1 (the P release's) is read only: its field set is
// V1_RECORD_FIELDS and its lines come from tests/fixtures/retention (written by the P release's own writer).
const RECORD_FIELDS = ['basis', 'classes', 'clauseIds', 'day', 'delayReasonStatus', 'disposalUnitId', 'dueDay', 'expiryDay',
  'extensionUsed', 'formatVersion', 'justifiedDelay', 'kind', 'method', 'occurredAt', 'operationId', 'partCount', 'phase', 'timeliness'];
const V1_RECORD_FIELDS = ['basis', 'classes', 'clauseIds', 'day', 'disposalUnitId', 'dueDay', 'expiryDay', 'extensionUsed', 'formatVersion',
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

test('P07b CD-09-C: a deletion that ran but answered with an invalid receipt is neither failed nor completed', async () => {
  for (const receipt of [at => ({ completedAt: at, method: 'soft-delete' }), at => ({ completedAt: '2026-11-01T01:59:59.999Z', method: 'operational-store-deletion' }),
    at => ({ completedAt: at, method: 'operational-store-deletion', unit: 'extra' })]) {
    const store = journal(), stored = { payload: true }, at = '2026-11-01T02:00:00.000Z';
    await assert.rejects(P.decidePurposeEnd(store, ended(), noFacts(), at, async () => { stored.payload = false; return receipt(at); }),
      e => e.code === 'DestructionReceiptInvalid');
    assert.equal(stored.payload, false, 'the payload was deleted before the receipt was read');
    assert.deepEqual(store.lines.map(l => l.phase), ['started'], 'started stays the last record');
  }
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
/** A valid format-2 started record (a new attempt), and the terminal record of the same attempt. */
const sample = (patch = {}) => ({ formatVersion: 2, kind: 'operational-deletion', operationId: randomUUID(), phase: 'started',
  occurredAt: '2026-11-01T02:00:00.000Z', day: '2026-11-01', disposalUnitId: unit(), classes: [], clauseIds: ['privacy:21.1'],
  partCount: 1, expiryDay: '2026-11-01', extensionUsed: false, dueDay: '2026-11-06', timeliness: 'within-five-days',
  delayReasonStatus: 'not-required', justifiedDelay: null, method: 'operational-store-deletion', basis: 'privacy-act-21-and-decree-16-1-1', ...patch });
const seoulDay = at => new Date(Date.parse(at) + 9 * 3600_000).toISOString().slice(0, 10);
function closing(started, phase, occurredAt = started.occurredAt) {
  const timeliness = seoulDay(occurredAt) <= started.dueDay ? 'within-five-days' : 'overdue';
  return { ...started, phase, occurredAt, day: seoulDay(occurredAt), timeliness,
    delayReasonStatus: timeliness === 'within-five-days' ? 'not-required' : started.justifiedDelay === null ? 'missing' : 'recorded' };
}

test('P09 the ledger is created only as its header with the database\'s ledger ID, never by an append, and reads back in order', () => {
  const dir = ledgerDir(), ledger = new P.PurposeLedgerFile(dir), id = randomUUID();
  assert.equal(ledger.read(), null);
  const a = sample(), b = closing(a, 'completed');
  // r3 C5: a missing ledger is the gate's question (lost, or never initialized); an append never answers it with a header.
  assert.throws(() => ledger.append(id, a), e => e.code === 'PurposeLedgerMissing');
  assert.equal(ledger.read(), null, 'the refused append wrote nothing');
  ledger.create(id);
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
  ledger.create(id);
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
    ledger.create(id); ledger.append(id, sample()); ledger.append(id, sample());
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

function exchange(socket = new EventEmitter()) {
  const request = new EventEmitter(), response = new EventEmitter();
  response.writableFinished = false; response.destroyed = false;
  socket.destroyed = false; request.socket = socket;
  return { request, response, socket };
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
  // Pipelined answers on one connection: the second is still queued (it never gets the socket) when the client cuts the
  // connection - only the connection's close says it ended.
  const shared = new EventEmitter();
  const head = exchange(shared), queued = exchange(shared);
  deliveries.track(AUTHOR, head.request, head.response);
  deliveries.track(AUTHOR, queued.request, queued.response);
  const third = deliveries.settled(AUTHOR);
  assert.equal(await state(third), 'waiting');
  shared.destroyed = true; shared.emit('close');
  assert.equal(await state(third), 'settled');
  assert.equal(deliveries.pending(AUTHOR), 0);
});

// ── F3/F4/F5: the destruction service against a transaction double of the database ──
//
// The double answers the statements the service sends (by their text) from one in-memory state and applies a
// transaction's writes only when its callback returns: a failing commit (commitFails) leaves the state as it was, as
// PostgreSQL does. No SQL engine: the PostgreSQL behaviour of the same paths is tests/e2e/test_draft_purpose.py.

function database(state) {
  const sql = strings => strings.join('?').replace(/\s+/g, ' ');
  const view = s => ({ ...s.anchor });
  function handle(text, values, writes, mode, tx) {
    // CD-09-C RC5: every statement with the transaction it ran in (an autocommit statement is its own transaction).
    state.txlog?.push({ tx, text });
    if (state.dbDown) throw Object.assign(new Error('SYN database unreachable'), { code: 'P1001' });
    // r3: the confirmation read opens its own bounded transaction. `confirmFails` makes that read time out (the lock
    // it waits on is held elsewhere) without touching anything the attempt itself did.
    if (/^SET LOCAL lock_timeout/.test(text)) {
      state.log.push('confirm');
      if (state.confirmFails > 0) { state.confirmFails--; throw Object.assign(new Error('SYN lock timeout'), { code: 'P2010', meta: { code: '55P03' } }); }
      return 0;
    }
    if (/pg_advisory_xact_lock/.test(text)) { state.log.push(/hashtextextended/.test(text) ? 'hold-lock' : 'ledger-lock'); return mode === 'q' ? [] : 0; }
    if (/to_regclass/.test(text)) return [{ anchor: state.migrated ? 'PurposeLedgerAnchor' : null, ended: state.migrated ? 'ReportDraftPurposeEnd' : null }];
    if (/FROM "StudyState" WHERE uid = \? FOR UPDATE/.test(text)) return [{ uid: values[0] }];
    if (/AS "left"/.test(text))
      return [{ left: [...state.ended.keys(), ...state.live.keys()].filter(unit => values[0].includes(unit)).length }];
    if (/= ANY\(/.test(text) && /FROM "ReportDraftPurposeEnd"/.test(text))
      return [...state.ended.keys()].filter(u => values[0].includes(u)).map(u => ({ disposalUnitId: u }));
    if (/= ANY\(/.test(text) && /FROM "ReportDraft"/.test(text))
      return [...state.live.keys()].filter(u => values[0].includes(u)).map(u => ({ workUnit: u }));
    if (/FROM "ReportDraft" WHERE "workUnit" = \?/.test(text) && /^SELECT/.test(text)) return [{ n: state.live.has(values[0]) ? 1 : 0 }];
    if (/AS any/.test(text)) return [{ any: state.works || state.live.size > 0 || state.ended.size > 0 }];
    if (/AS "left"/.test(text)) return [{ left: [...state.ended.keys()].filter(unit => values[0].includes(unit)).length }];
    if (/FROM "PurposeLedgerAnchor"/.test(text) && /^SELECT initialized/.test(text)) return [{ initialized: state.anchor.initialized }];
    if (/FROM "PurposeLedgerAnchor"/.test(text)) return [view(state)];
    if (/SELECT \* FROM "ReportDraftPurposeEnd"/.test(text)) return state.ended.has(values[0]) ? [structuredClone(state.ended.get(values[0]))] : [];
    if (/SELECT 1 (AS present )?FROM "ReportDraftPurposeEnd"/.test(text)) return state.ended.has(values[0]) ? [{ present: 1 }] : [];
    if (/SELECT "disposalUnitId"/.test(text)) {
      const rows = [...state.ended.values()].filter(r => !/WHERE "deliverySettled"/.test(text) || r.deliverySettled);
      return rows.map(r => ({ disposalUnitId: r.disposalUnitId, author: r.author, deliverySettled: r.deliverySettled }));
    }
    if (/emr_access.holds_for/.test(text)) {
      state.log.push('holds');
      // CD-09-C: the holds a case stored for this record (rows as P06's hold() builds them), and their clause versions.
      return (state.holds ?? []).filter(h => JSON.parse(h.body).recordId === values[0]).map(h => ({ hold_id: h.holdId, phase: h.phase, body: h.body }));
    }
    if (/emr_access.clause_versions/.test(text))
      return (clauses.get(values[0]) ?? []).map(c => ({ law: c.law, article: c.article, publication: c.publication,
        published_at: c.publishedAt, effective_at: c.effectiveAt }));
    if (/^DELETE FROM "ReportDraftPurposeEnd"/.test(text)) { const n = state.ended.has(values[0]) ? 1 : 0; writes.push(s => s.ended.delete(values[0])); return n; }
    if (/^UPDATE "PurposeLedgerAnchor" SET seq/.test(text)) {
      const move = s => Object.assign(s.anchor, { seq: values[0], initialized: true, lastCompletedUnit: values[1], lastCompletedAt: values[2] });
      // The counterexample of RC5: an anchor move that commits in a transaction of its own, before the deletion's.
      if (state.splitAnchor) {
        const own = ++state.txseq, entry = state.txlog?.at(-1);
        if (entry) entry.tx = own;                 // this statement ran in that transaction, not the caller's
        state.txlog?.push({ tx: own, text: 'COMMIT' }); move(state);
      }
      else writes.push(move);
      return 1;
    }
    if (/^UPDATE "PurposeLedgerAnchor" SET initialized/.test(text)) { writes.push(s => { s.anchor.initialized = true; }); return 1; }
    if (/^UPDATE "ReportDraftPurposeEnd" SET "deliverySettled" = true WHERE "disposalUnitId"/.test(text)) {
      if (state.settleFails-- > 0) throw Object.assign(new Error('SYN connection lost'), { code: 'P1017' });
      writes.push(s => { const r = s.ended.get(values[0]); if (r) r.deliverySettled = true; }); return 1;
    }
    if (/^UPDATE "ReportDraftPurposeEnd" SET "deliverySettled" = true WHERE NOT/.test(text)) { writes.push(s => s.ended.forEach(r => { r.deliverySettled = true; })); return 0; }
    if (/^UPDATE "ReportDraftPurposeEnd" SET attempts/.test(text)) { writes.push(s => { const r = s.ended.get(values[2] ?? values[1]); if (r) r.attempts++; }); return 1; }
    if (/^UPDATE "ReportDraft" SET present = false/.test(text)) {
      // A live copy's row of that work (state.live): emptied by the re-application.
      const n = state.live.has(values[0]) ? 1 : 0; writes.push(s => s.live.delete(values[0])); return n;
    }
    throw new Error('unexpected statement: ' + text);
  }
  const client = (writes, tx) => ({
    $queryRaw: async (strings, ...values) => handle(sql(strings), values, writes, 'q', tx),
    $executeRaw: async (strings, ...values) => handle(sql(strings), values, writes, 'x', tx),
  });
  const db = {
    async $transaction(fn) {
      const writes = [], tx = ++state.txseq;
      const result = await fn(client(writes, tx));
      if (writes.length && state.commitFails > 0) { state.commitFails--; throw new Error('SYN COMMIT FAILURE; transaction rolled back'); }
      // What the served stack showed: COMMIT failed in PostgreSQL and the client still saw a resolved transaction.
      if (writes.length && state.silentCommitFails > 0) { state.silentCommitFails--; return result; }
      writes.forEach(w => w(state));
      state.txlog?.push({ tx, text: 'COMMIT' });
      // r3: the COMMIT took effect and its answer was lost (the client sees an error for a committed transaction).
      if (writes.length && state.rejectAfterCommit > 0) { state.rejectAfterCommit--; throw Object.assign(new Error('SYN answer lost after COMMIT'), { code: 'P1017' }); }
      return result;
    },
  };
  // Outside a transaction a statement commits on its own.
  const autocommit = mode => async (strings, ...values) => {
    const writes = [], result = handle(sql(strings), values, writes, mode, ++state.txseq);
    writes.forEach(w => w(state)); return result;
  };
  db.$queryRaw = autocommit('q');
  db.$executeRaw = autocommit('x');
  return db;
}
function stateWith(rows, anchor = {}) {
  return { anchor: { ledgerId: randomUUID(), seq: 0, initialized: true, lastCompletedUnit: null, lastCompletedAt: null, ...anchor },
    ended: new Map(rows.map(r => [r.disposalUnitId, r])), works: true, log: [], commitFails: 0, silentCommitFails: 0, settleFails: 0,
    live: new Map(), confirmFails: 0, rejectAfterCommit: 0, migrated: true, dbDown: false, txseq: 0, txlog: null, splitAnchor: false };
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
  // r3 C5 (R2-03): a copy whose drafts the migration numbered, with no ledger and no prepared adoption, is the same input
  // as a pre-first-start copy restored after destructions: it stays closed and nothing is created for it.
  const numbered = stateWith([], { initialized: false });
  await assert.rejects(new P.DraftPurposeDisposal(database(numbered), missing, null, NOW).openGate(),
    e => e.code === 'PurposeLedgerInitializationRequired');
  assert.equal(missing.read(), null);
  assert.equal(numbered.anchor.initialized, false);
  // The first work handed out through the server writes the ledger first, then the database's flag (same transaction).
  const first = stateWith([], { initialized: false }), firstLedger = new P.PurposeLedgerFile(path.join(ledgerDir(), 'first'));
  first.works = false;
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

// ── r3: one commit judgement (committed / not committed / unknown) for every path ──
//
// consult-cd09p-r3-precheck-report.md C2-C5. Each case first makes the branch happen through the double (what the
// transaction did, what its answer said, whether the confirmation read could run) and checks that it happened, then
// asserts the product's outcome: the ledger's lines, the payload, the answer or the gate.

const phasesOf = (ledger, u) => (ledger.read()?.entries ?? []).filter(e => e.record.disposalUnitId === u).map(e => e.record.phase);
const quiet = async work => {
  const original = console.error; console.error = () => {};
  try { return await work(); } finally { console.error = original; }
};

test('R3-C2b new destruction: a confirmation read that fails leaves only started, then converges from the real outcome', async () => {
  // (1) The deletion committed, its confirmation read timed out.
  const row = ended(), state = stateWith([row]);
  const ledger = ledgerFor(state.anchor.ledgerId);
  const service = new P.DraftPurposeDisposal(database(state), ledger, null, NOW);
  state.confirmFails = 1;
  await assert.rejects(service.destroy(row.disposalUnitId));
  assert.equal(state.confirmFails, 0, 'the confirmation read was reached and failed');
  assert.ok(!state.ended.has(row.disposalUnitId), 'the deletion itself committed');
  assert.deepEqual(phasesOf(ledger, row.disposalUnitId), ['started'], 'neither completed nor a failed that says rolled back');
  // The next attempt matches the anchor the committed deletion moved: completed once, with the commit's own time.
  const again = await service.destroy(row.disposalUnitId);
  assert.equal(again.outcome, 'absent');
  assert.deepEqual(phasesOf(ledger, row.disposalUnitId), ['started', 'completed']);
  // (2) The deletion rolled back, its confirmation read timed out.
  const kept = ended(), rolled = stateWith([kept]);
  const ledger2 = ledgerFor(rolled.anchor.ledgerId);
  const service2 = new P.DraftPurposeDisposal(database(rolled), ledger2, null, NOW);
  rolled.commitFails = 1; rolled.confirmFails = 1;
  await assert.rejects(service2.destroy(kept.disposalUnitId));
  assert.equal(rolled.confirmFails, 0);
  assert.ok(rolled.ended.has(kept.disposalUnitId), 'the deletion rolled back');
  assert.deepEqual(phasesOf(ledger2, kept.disposalUnitId), ['started']);
  assert.equal(rolled.anchor.seq, 0);
  // The same process judges its own attempt again: not committed -> failed, then a new attempt completes.
  const retried = await service2.destroy(kept.disposalUnitId);
  assert.equal(retried.outcome, 'destroyed');
  assert.deepEqual(phasesOf(ledger2, kept.disposalUnitId), ['started', 'failed', 'started', 'completed']);
  assert.ok(!rolled.ended.has(kept.disposalUnitId));
});

test('R3-C3d(b) while one attempt is unknown no other unit starts; another process cannot settle it', async () => {
  const a = ended(), b = ended(), state = stateWith([a, b]);
  const ledger = ledgerFor(state.anchor.ledgerId);
  const service = new P.DraftPurposeDisposal(database(state), ledger, null, NOW);
  state.commitFails = 1; state.confirmFails = 2;
  await assert.rejects(service.destroy(a.disposalUnitId));
  assert.deepEqual(phasesOf(ledger, a.disposalUnitId), ['started']);
  // B: refused before any record (the unknown A must not be buried under another unit's records).
  await quiet(async () => { await assert.rejects(service.destroy(b.disposalUnitId), e => e.code === 'PurposeIntentIncomplete'); });
  assert.equal(state.confirmFails, 0, 'A was judged again and stayed unknown');
  assert.deepEqual(phasesOf(ledger, b.disposalUnitId), []);
  assert.ok(state.ended.has(b.disposalUnitId));
  // A process without the attempt (the sweep run, a restart) has no evidence: R4, closed, nothing written.
  const before = fs.readFileSync(ledger.file);
  const sweep = new P.DraftPurposeDisposal(database(state), ledger, null, NOW);
  await assert.rejects(sweep.sweep(), e => e.code === 'PurposeIntentIncomplete');
  await assert.rejects(sweep.openGate(), e => e.code === 'PurposeIntentIncomplete');
  assert.deepEqual(fs.readFileSync(ledger.file), before);
  // The process that holds the attempt resolves it once it can read: failed, then both units are destroyed.
  assert.equal((await service.destroy(a.disposalUnitId)).outcome, 'destroyed');
  assert.equal((await service.destroy(b.disposalUnitId)).outcome, 'destroyed');
  assert.deepEqual(phasesOf(ledger, a.disposalUnitId), ['started', 'failed', 'started', 'completed']);
  assert.deepEqual(phasesOf(ledger, b.disposalUnitId), ['started', 'completed']);
});

test('R3-C3c a ledger as long as the anchor says but with another meaning at the anchor\'s position stays closed', async () => {
  const a = ended(), state = stateWith([a]);
  const ledger = ledgerFor(state.anchor.ledgerId);
  const started = sample({ disposalUnitId: a.disposalUnitId });
  ledger.append(state.anchor.ledgerId, started);
  ledger.append(state.anchor.ledgerId, closing(started, 'failed'));
  Object.assign(state.anchor, { seq: 2, lastCompletedUnit: a.disposalUnitId, lastCompletedAt: '2026-11-01T01:30:00.000Z' });
  assert.equal(ledger.read().entries.length, state.anchor.seq, 'same length: only the meaning differs');
  const before = fs.readFileSync(ledger.file);
  await assert.rejects(new P.DraftPurposeDisposal(database(state), ledger, null, NOW).openGate(), e => e.code === 'PurposeLedgerAnchorMismatch');
  const S = require(path.join(api, 'src/emr-retention/draft-purpose-sweep.ts'));
  await assert.rejects(S.runDraftPurposeSweep(database(state), ledger.directory), e => e.code === 'PurposeLedgerAnchorMismatch');
  assert.deepEqual(fs.readFileSync(ledger.file), before);
  assert.equal(state.anchor.seq, 2);
});

test('R3-C4d a started attempt with no evidence (another process stopped after it) closes the gate and the sweep', async () => {
  const a = ended(), state = stateWith([a]);
  const ledger = ledgerFor(state.anchor.ledgerId);
  ledger.append(state.anchor.ledgerId, sample({ disposalUnitId: a.disposalUnitId }));
  assert.notEqual(state.anchor.lastCompletedUnit, a.disposalUnitId);
  assert.ok(state.ended.has(a.disposalUnitId));
  const before = fs.readFileSync(ledger.file);
  await assert.rejects(new P.DraftPurposeDisposal(database(state), ledger, null, NOW).openGate(), e => e.code === 'PurposeIntentIncomplete');
  const S = require(path.join(api, 'src/emr-retention/draft-purpose-sweep.ts'));
  await assert.rejects(S.runDraftPurposeSweep(database(state), ledger.directory), e => e.code === 'PurposeIntentIncomplete');
  assert.deepEqual(fs.readFileSync(ledger.file), before, 'no failed is synthesized from this copy');
  assert.ok(state.ended.has(a.disposalUnitId));
});

test('R3-C3f(나) a started record whose append fails: nothing is deleted, the anchor and the payload stay', async () => {
  const a = ended(), state = stateWith([a]);
  const ledger = ledgerFor(state.anchor.ledgerId);
  let reached = 0;
  const append = ledger.append.bind(ledger);
  ledger.append = (id, record) => { if (record.phase === 'started') { reached++; throw new Error('SYN disk full'); } return append(id, record); };
  const out = await new P.DraftPurposeDisposal(database(state), ledger, null, NOW).destroy(a.disposalUnitId);
  assert.equal(reached, 1, 'the started append was reached');
  assert.deepEqual([out.outcome, out.code], ['refused', 'DestructionJournalUnavailable']);
  assert.ok(state.ended.has(a.disposalUnitId));
  assert.deepEqual([state.anchor.seq, state.anchor.lastCompletedUnit], [0, null]);
  assert.deepEqual(phasesOf(ledger, a.disposalUnitId), []);
});

/** A completed unit whose payload a restored copy holds again (ended row, or the live row of a copy taken before the end). */
function restoredCompleted({ live = false } = {}) {
  const row = ended(), state = stateWith([row]);
  const ledger = ledgerFor(state.anchor.ledgerId);
  return (async () => {
    await new P.DraftPurposeDisposal(database(state), ledger, null, NOW).destroy(row.disposalUnitId);
    assert.deepEqual(phasesOf(ledger, row.disposalUnitId), ['started', 'completed']);
    if (live) state.live.set(row.disposalUnitId, { uid: row.uid, author: row.author, findings: row.findings });
    else state.ended.set(row.disposalUnitId, structuredClone(row));
    return { row, state, ledger, bytes: fs.readFileSync(ledger.file) };
  })();
}

test('R3-C2b/C4 sweep re-application: committed, not committed and unknown are three outcomes; the original completed stands', async () => {
  const S = require(path.join(api, 'src/emr-retention/draft-purpose-sweep.ts'));
  // committed
  let r = await restoredCompleted();
  let report = await S.runDraftPurposeSweep(database(r.state), r.ledger.directory);
  assert.deepEqual(report.results, [{ unit: r.row.disposalUnitId, outcome: 'reapplied' }]);
  assert.equal(report.complete, true);
  assert.ok(!r.state.ended.has(r.row.disposalUnitId));
  assert.deepEqual(fs.readFileSync(r.ledger.file), r.bytes);
  // not committed (the re-application's COMMIT failed but answered success)
  r = await restoredCompleted();
  r.state.silentCommitFails = 1;
  report = await S.runDraftPurposeSweep(database(r.state), r.ledger.directory);
  assert.equal(r.state.silentCommitFails, 0, 'the failing COMMIT was reached');
  assert.deepEqual(report.results, [{ unit: r.row.disposalUnitId, outcome: 'reapply-not-committed' }]);
  assert.equal(report.complete, false);
  assert.ok(r.state.ended.has(r.row.disposalUnitId));
  assert.deepEqual(fs.readFileSync(r.ledger.file), r.bytes, 'the original completed stands; no failed for a re-application');
  // unknown (committed, the confirmation read timed out)
  r = await restoredCompleted();
  r.state.confirmFails = 1;
  report = await S.runDraftPurposeSweep(database(r.state), r.ledger.directory);
  assert.equal(r.state.confirmFails, 0);
  assert.deepEqual(report.results, [{ unit: r.row.disposalUnitId, outcome: 'reapply-unconfirmed' }]);
  assert.equal(report.complete, false);
  assert.deepEqual(fs.readFileSync(r.ledger.file), r.bytes);
});

test('R3-C4a′ the sweep re-applies a completed unit a live copy still holds in the author\'s row', async () => {
  const S = require(path.join(api, 'src/emr-retention/draft-purpose-sweep.ts'));
  const r = await restoredCompleted({ live: true });
  assert.ok(r.state.live.has(r.row.disposalUnitId) && !r.state.ended.has(r.row.disposalUnitId));
  r.state.silentCommitFails = 1;
  let report = await S.runDraftPurposeSweep(database(r.state), r.ledger.directory);
  assert.deepEqual(report.results, [{ unit: r.row.disposalUnitId, outcome: 'reapply-not-committed' }]);
  assert.ok(r.state.live.has(r.row.disposalUnitId));
  report = await S.runDraftPurposeSweep(database(r.state), r.ledger.directory);
  assert.deepEqual(report.results, [{ unit: r.row.disposalUnitId, outcome: 'reapplied' }]);
  assert.equal(report.complete, true);
  assert.ok(!r.state.live.has(r.row.disposalUnitId));
  assert.deepEqual(fs.readFileSync(r.ledger.file), r.bytes);
});

test('R3-C2b/C4b gate re-application opens only when the committed database confirms it', async () => {
  let r = await restoredCompleted();
  assert.equal((await new P.DraftPurposeDisposal(database(r.state), r.ledger, null, NOW).openGate()).reapplied, 1);
  r = await restoredCompleted();
  r.state.commitFails = 1;
  await assert.rejects(new P.DraftPurposeDisposal(database(r.state), r.ledger, null, NOW).openGate(), e => e.code === 'PurposeReapplyNotCommitted');
  assert.deepEqual(fs.readFileSync(r.ledger.file), r.bytes);
  r = await restoredCompleted({ live: true });
  r.state.confirmFails = 1;
  await assert.rejects(new P.DraftPurposeDisposal(database(r.state), r.ledger, null, NOW).openGate(), e => e.code === 'PurposeReapplyUnconfirmed');
  assert.equal(r.state.confirmFails, 0);
  assert.deepEqual(fs.readFileSync(r.ledger.file), r.bytes);
  // Once the read can run again, the same database opens (the re-application had committed).
  await new P.DraftPurposeDisposal(database(r.state), r.ledger, null, NOW).openGate();
});

// ── r3 C5: the first start and what the product can tell apart ──

function emptyDir() { return path.join(ledgerDir(), 'purpose'); }

test('R3-C5 I2 a prepared adoption is consumed once by the first gate: consumed, header, initialized, in that order', async () => {
  const dir = emptyDir(), state = stateWith([], { initialized: false });
  state.migrated = false;
  const prepared = await P.prepareLedgerAdoption(database(state), { KIN_PURPOSE_LEDGER_DIR: dir });
  assert.equal(prepared.state, 'prepared');
  const ledger = new P.PurposeLedgerFile(dir);
  assert.equal(ledger.read(), null);
  assert.equal(ledger.readAdoption().state, 'prepared');
  state.migrated = true;            // the P migration runs after the preparation
  assert.ok(state.works && !state.anchor.initialized && state.anchor.seq === 0);
  await new P.DraftPurposeDisposal(database(state), ledger, null, NOW).openGate();
  assert.deepEqual([ledger.readAdoption().state, ledger.readAdoption().ledgerId], ['consumed', state.anchor.ledgerId]);
  assert.equal(ledger.read().ledgerId, state.anchor.ledgerId);
  assert.equal(state.anchor.initialized, true);
});

test('R3-C5 I3/I4/I5/I6 inputs the product can tell apart stay closed and create nothing', async () => {
  // I3: works, no ledger, no adoption.
  let dir = emptyDir(), state = stateWith([], { initialized: false }), ledger = new P.PurposeLedgerFile(dir);
  await assert.rejects(new P.DraftPurposeDisposal(database(state), ledger, null, NOW).openGate(), e => e.code === 'PurposeLedgerInitializationRequired');
  assert.equal(fs.existsSync(dir), false, 'nothing created');
  // I9: only an ended row.
  state = stateWith([ended()], { initialized: false }); state.works = false;
  await assert.rejects(new P.DraftPurposeDisposal(database(state), new P.PurposeLedgerFile(emptyDir()), null, NOW).openGate(),
    e => e.code === 'PurposeLedgerInitializationRequired');
  // I4: the adoption was consumed and the ledger is gone (the database is the one from before the first start).
  dir = emptyDir(); state = stateWith([], { initialized: false }); state.migrated = false;
  await P.prepareLedgerAdoption(database(state), { KIN_PURPOSE_LEDGER_DIR: dir }); state.migrated = true;
  ledger = new P.PurposeLedgerFile(dir);
  await new P.DraftPurposeDisposal(database(state), ledger, null, NOW).openGate();
  fs.rmSync(ledger.file);
  const d0 = stateWith([], { initialized: false, ledgerId: state.anchor.ledgerId });
  await assert.rejects(new P.DraftPurposeDisposal(database(d0), ledger, null, NOW).openGate(), e => e.code === 'PurposeLedgerMissing');
  assert.equal(ledger.read(), null);
  // I5 (C5-8): an initialized database beside an older directory that still holds the prepared adoption: not consumed.
  dir = emptyDir(); state = stateWith([], { initialized: false }); state.migrated = false;
  await P.prepareLedgerAdoption(database(state), { KIN_PURPOSE_LEDGER_DIR: dir }); state.migrated = true;
  const current = stateWith([], { initialized: true });
  ledger = new P.PurposeLedgerFile(dir);
  await assert.rejects(new P.DraftPurposeDisposal(database(current), ledger, null, NOW).openGate(), e => e.code === 'PurposeLedgerMissing');
  assert.equal(ledger.readAdoption().state, 'prepared');
  assert.equal(ledger.read(), null);
  // I6: a ledger of another ID beside a database that never saw it.
  const other = ledgerFor(randomUUID());
  await assert.rejects(new P.DraftPurposeDisposal(database(stateWith([], { initialized: false })), other, null, NOW).openGate(),
    e => e.code === 'PurposeLedgerMismatch');
});

test('R3-C5-6 no other door opens an uninitialized copy: destroy, sweep and the first save refuse and create nothing', async () => {
  const dir = emptyDir(), row = ended(), state = stateWith([row], { initialized: false }), ledger = new P.PurposeLedgerFile(dir);
  const service = new P.DraftPurposeDisposal(database(state), ledger, null, NOW);
  await quiet(async () => { await assert.rejects(service.destroy(row.disposalUnitId), e => e.code === 'PurposeLedgerInitializationRequired'); });
  await assert.rejects(service.sweep(), e => e.code === 'PurposeLedgerInitializationRequired');
  const db = database(state);
  await assert.rejects(db.$transaction(tx => new P.DraftPurposeDisposal(db, ledger, null, NOW).ensureLedger(tx)),
    e => e.code === 'PurposeLedgerInitializationRequired');
  assert.equal(fs.existsSync(dir), false);
  assert.ok(state.ended.has(row.disposalUnitId));
  assert.equal(state.anchor.initialized, false);
});

test('R3-C5-5 the preparation refuses P1-P5 and changes nothing', async () => {
  const fresh = () => { const s = stateWith([], { initialized: false }); s.migrated = false; return s; };
  // P1: no directory, a relative one, or one inside the backed-up EMR state.
  for (const env of [{}, { KIN_PURPOSE_LEDGER_DIR: 'relative' }, { KIN_PURPOSE_LEDGER_DIR: '/var/lib/kin-emr/p', KIN_EMR_STATE_DIR: '/var/lib/kin-emr' }])
    await assert.rejects(P.prepareLedgerAdoption(database(fresh()), env), e => /^PurposeLedger(DirectoryRequired|InsideBackup)$/.test(e.code));
  // P2: a ledger is already there.
  let dir = emptyDir(); const l2 = new P.PurposeLedgerFile(dir); l2.create(randomUUID());
  let bytes = fs.readFileSync(l2.file);
  await assert.rejects(P.prepareLedgerAdoption(database(fresh()), { KIN_PURPOSE_LEDGER_DIR: dir }), e => e.code === 'PurposeAdoptionLedgerExists');
  assert.deepEqual(fs.readFileSync(l2.file), bytes); assert.equal(l2.readAdoption(), null);
  // P3: an adoption record is already there (prepared, or consumed).
  dir = emptyDir();
  await P.prepareLedgerAdoption(database(fresh()), { KIN_PURPOSE_LEDGER_DIR: dir });
  const l3 = new P.PurposeLedgerFile(dir); bytes = fs.readFileSync(l3.adoptionFile);
  await assert.rejects(P.prepareLedgerAdoption(database(fresh()), { KIN_PURPOSE_LEDGER_DIR: dir }), e => e.code === 'PurposeAdoptionExists');
  assert.deepEqual(fs.readFileSync(l3.adoptionFile), bytes);
  // P4: the database already has the P migration.
  dir = emptyDir(); const migrated = fresh(); migrated.migrated = true;
  await assert.rejects(P.prepareLedgerAdoption(database(migrated), { KIN_PURPOSE_LEDGER_DIR: dir }), e => e.code === 'PurposeAdoptionAfterMigration');
  assert.equal(fs.existsSync(dir), false);
  // P5: the database cannot be reached.
  dir = emptyDir(); const down = fresh(); down.dbDown = true;
  await assert.rejects(P.prepareLedgerAdoption(database(down), { KIN_PURPOSE_LEDGER_DIR: dir }), e => e.code === 'PurposeAdoptionDatabaseUnavailable');
  assert.equal(fs.existsSync(dir), false);
});

// ── r3 C2-a: the public end entry points (Discard, Clear) against a transaction double ──
//
// The real PacsReportDraft.discardDraft / putReport run their own transaction through the request's record port. The
// double decides, per case, whether that transaction's writes become durable and what its answer says, and whether the
// confirmation read can run. The destruction service is the real one with its scheduling observed.

const RD = require(path.join(api, 'src/pacs/report-draft.ts'));
const { TransactionLocks } = require(path.join(root, 'tests/transaction_locks.cjs'));
const V = require(path.join(api, 'src/pacs/values.ts'));
const scheduled = [];
const endDb = { current: null };
const forward = new Proxy({}, { get: (_, key) => endDb.current[key] });
const endService = P.configureDraftPurpose(new P.DraftPurposeDisposal(forward, new P.PurposeLedgerFile(ledgerDir()), null, NOW));
endService.scheduleDestruction = u => { scheduled.push(u); };

function endWorld({ commit, reject, confirmFails = 0 }) {
  const epoch = randomUUID(), work = unit();
  const durable = { draft: { uid: UID, author: AUTHOR, findings: 'SYN end text', conclusion: 'SYN c', recommendation: '', baseVersion: 0,
    citations: null, structured: null, revision: 3, present: true, updatedAt: new Date(START), workUnit: work, workSince: new Date(START),
    workIntent: 'approve' }, ended: new Map() };
  const study = { uid: UID, institutionId: 'syn-inst', draftEpoch: epoch, rs: 'N', ss: 'Verified', em: 'N' };
  const seen = { confirms: 0, confirmFailed: 0, transactions: 0, order: [] };
  // CD-09 W-R: a draft writer owns the Study UID's fixed-record key for its whole transaction before StudyState; another
  // transaction holding that key makes it wait. PostgreSQL's own scheduling is tests/emr/d/related_boundaries_pg_test.cjs.
  const locks = new TransactionLocks();
  const read = (s, text, values) => {
    if (/FROM "StudyState"/.test(text)) return [structuredClone(study)];
    if (/FROM "ReportDraftPurposeEnd"/.test(text)) return s.ended.has(values[0]) ? [{ present: 1 }] : [];
    if (/FROM "ReportDraft"/.test(text)) return s.draft ? [structuredClone(s.draft)] : [];
    if (/FROM "Report" WHERE uid/.test(text)) return [];             // the commit's head report: none yet
    throw new Error('unexpected read: ' + text);
  };
  const confirmFail = () => { if (confirmFails > 0) { confirmFails--; seen.confirmFailed++; throw Object.assign(new Error('SYN lock timeout'), { code: 'P2010', meta: { code: '55P03' } }); } };
  const prisma = {
    // The confirmation read (its own bounded transaction).
    async $transaction(fn) {
      seen.confirms++; confirmFail();
      return fn({ $executeRaw: async () => 0, $queryRaw: async (strings, ...values) => read(durable, strings.join('?'), values) });
    },
    async $queryRaw(strings, ...values) { seen.confirms++; confirmFail(); return read(durable, strings.join('?'), values); },
  };
  const transactionWithRecords = async fn => {
    seen.transactions++;
    const local = structuredClone(durable);
    const tx = {
      $executeRaw: async () => 0,
      $queryRaw: async (strings, ...values) => {
        const text = strings.join('?');
        if (/pg_advisory_xact_lock/.test(text) && typeof values[0] === 'string' && values[0].startsWith('["emr-fixed-record",')) {
          await locks.acquire(local, values[0]); seen.order.push('fixed ' + values[0]); return [{ locked: '' }];
        }
        if (/FROM "StudyState"/.test(text)) seen.order.push('StudyState');
        return read(local, text, values);
      },
      reportDraftPurposeEnd: { create: async ({ data }) => { local.ended.set(data.disposalUnitId, data); return data; } },
      reportDraft: {
        updateMany: async ({ data }) => { Object.assign(local.draft, data); return { count: 1 }; },
        findUnique: async () => structuredClone(local.draft), create: async ({ data }) => { local.draft = data; return data; },
      },
      auditLog: { create: async () => ({}) },
      report: { findUnique: async () => null, upsert: async ({ create }) => structuredClone(create) },
      reportVersion: { findFirst: async () => null, create: async ({ data }) => structuredClone(data) },
      studyState: { update: async ({ data }) => ({ ...structuredClone(study), ...data }) },
    };
    let value;
    try {
      value = await fn(tx, async () => {});
      if (commit) Object.assign(durable, local);
    } finally { locks.release(local); }      // a transaction-level key ends with COMMIT or rollback
    if (reject) throw Object.assign(new Error('SYN answer lost'), { code: 'P1017' });
    return value;
  };
  const c = { roles: ['radiologist'], institution: 'syn-inst', sub: 'syn-sub', actor: AUTHOR, kind: 'user' };
  const facts = { request: { work: { transactionWithRecords }, requireCurrent: async () => {},
    facts: { surface: 'syn', actor: AUTHOR, roles: ['radiologist'], institution: 'syn-inst' } }, issuer: 'syn', ip: null, requestId: 'syn-req' };
  const studyAccess = { prepare: async () => {}, prepareSourceIdentity: async () => {}, require: async () => {}, assertUnsplitSource: () => {} };
  const service = new RD.PacsReportDraft(prisma, studyAccess, { visible: () => true }, {}, { reportLimitChecked: fn => fn() }, {});
  const body = { expectedOwner: { institution: 'syn-inst', sub: 'syn-sub', author: AUTHOR }, expectedRevision: V.draftToken(epoch, 3) };
  endDb.current = prisma;
  return { service, durable, seen, work, c, facts, body, studyAccess, locks };
}
const RC = require(path.join(api, 'src/pacs/report-commit.ts'));
// The commit's own evidence reads: no head version and no citation or structure in this synthetic work.
const commitEvidence = { citationKeys: v => v ?? [], structureKeys: v => v ?? [], versionCitations: async () => [],
  versionStructured: async () => [], citationBudget: async () => {}, structureBudget: async () => {} };
async function outcome(promise) {
  try { const value = await promise; return { status: 200, value }; }
  catch (error) { return { status: error.getStatus?.() ?? 500, code: error.getResponse?.()?.code ?? error.code, message: error.getResponse?.()?.message ?? error.message }; }
}
const settle = () => new Promise(r => setTimeout(r, 1300));

const ENTRY = {
  Discard: w => w.service.discardDraft(UID, w.body, w.c, null, w.facts),
  Clear: w => w.service.putReport(UID, { ...w.body, findings: '', conclusion: '', recommendation: '', baseVersion: 0, citationIds: [], structureIds: [] },
    w.c, null, w.facts),
  // The author's Reset of a study with no report yet: an explicit discard inside the commit's own transaction.
  Reset: w => new RC.PacsReportCommit({}, w.studyAccess, commitEvidence, w.service).commitReport(UID,
    { ...w.body, action: 'reset', reason: 'SYN reset', baseVersion: 0, findings: '', conclusion: '', recommendation: '' }, w.c, null, w.facts),
  // The author's signed approval of this work: the signature step answers what a server signature row would name.
  Approve: w => new RC.PacsReportCommit({}, w.studyAccess, commitEvidence, w.service, { sign: async (_tx, _request, _id, saved) =>
    ({ recordId: UID, versionId: String(saved.version), signedAt: END }) }).commitReport(UID,
    { ...w.body, action: 'approve', baseVersion: 0, findings: 'SYN end text', conclusion: 'SYN c', recommendation: '' }, w.c, null, w.facts),
};

for (const [name, call] of Object.entries(ENTRY)) {
  test(`R3-C2a ${name}: the six transaction outcomes are answered from the committed database, never from the promise`, async () => {
    const key = JSON.stringify(['emr-fixed-record', UID]);
    const run = async (mode, contend = false) => {
      scheduled.length = 0;
      const w = endWorld(mode), other = {};
      if (contend) await w.locks.acquire(other, key);
      const pending = outcome(call(w));
      if (contend) {
        await new Promise(r => setTimeout(r, 20));
        assert.equal(w.seen.transactions, 1, 'the entry point opened its transaction');
        assert.deepEqual(w.seen.order, [], 'no StudyState row while another transaction owns the record key');
        w.locks.release(other);
      }
      const out = await pending;
      assert.equal(w.seen.transactions, 1, 'the entry point ran its transaction');
      assert.deepEqual(w.seen.order.slice(0, 2), ['fixed ' + key, 'StudyState'], 'the record key comes before the StudyState row');
      assert.equal(w.locks.holders.size, 0, 'the key ends with the transaction');
      return { w, out, durableEnded: w.durable.ended.has(w.work) };
    };
    // commit + resolve, first waiting for another transaction's record key
    let r = await run({ commit: true, reject: false }, true);
    assert.equal(r.durableEnded, true); assert.equal(r.out.status, 200); assert.deepEqual(scheduled, [r.w.work]);
    // rollback + reject: the original error
    r = await run({ commit: false, reject: true });
    assert.equal(r.durableEnded, false); assert.equal(r.out.code, 'P1017'); assert.deepEqual(scheduled, []);
    // rollback + resolve (a COMMIT that failed answered as success)
    r = await run({ commit: false, reject: false });
    assert.equal(r.durableEnded, false);
    assert.deepEqual([r.out.status, r.out.code], [503, 'REPORT_DRAFT_END_NOT_SAVED']); assert.deepEqual(scheduled, []);
    // commit + reject: saved, the client re-reads; the destruction is scheduled
    r = await run({ commit: true, reject: true });
    assert.equal(r.durableEnded, true);
    assert.deepEqual([r.out.status, r.out.code], [503, 'REPORT_DRAFT_END_SAVED']);
    assert.match(r.out.message, /[가-힣]/);
    assert.deepEqual(scheduled, [r.w.work]);
    // commit + confirmation failure: unknown, nothing scheduled yet; the server judges again and then schedules
    r = await quiet(() => run({ commit: true, reject: false, confirmFails: 1 }));
    assert.equal(r.w.seen.confirmFailed, 1, 'the confirmation read was reached and failed');
    assert.deepEqual([r.out.status, r.out.code], [503, 'REPORT_DRAFT_END_UNCONFIRMED']);
    assert.doesNotMatch(r.out.message, /그대로/, 'unknown never says the draft is as it was');
    assert.deepEqual(scheduled, []);
    await settle();
    assert.deepEqual(scheduled, [r.w.work], 'converged: committed, destroyed once');
    // rollback + confirmation failure: unknown, then nothing
    r = await quiet(() => run({ commit: false, reject: false, confirmFails: 1 }));
    assert.equal(r.w.seen.confirmFailed, 1);
    assert.deepEqual([r.out.status, r.out.code], [503, 'REPORT_DRAFT_END_UNCONFIRMED']);
    await settle();
    assert.deepEqual(scheduled, [], 'converged: not committed, nothing to destroy');
    assert.equal(r.w.durable.draft.findings, 'SYN end text');
  });
}

// ── CD-09-C: format 2, the P release's format-1 ledgers, and the composed startup gate ──
//
// claude-plan-cd-09c.md sections 2-5 with the plan review's section 6 corrections. Format-1 ledgers are the bytes the P
// release (1f8249a) wrote itself (tests/fixtures/retention/make_v1_ledger.cjs); format-2 lines come from the writer of
// this tree through the service. A changed line is built from a record that is valid on its own (shown first), so each
// refusal is the targeted rule and not another decoder error. The second gate adapter is this test's own double.

const crypto = require('node:crypto');
const A = require(path.join(api, 'src/emr-contract/lawful-defaults.ts'));
const FIX = path.join(root, 'tests/fixtures/retention');
const META = JSON.parse(fs.readFileSync(path.join(FIX, 'v1-fixtures.json'), 'utf8'));
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const linesOf = file => fs.readFileSync(file, 'utf8').split('\n').slice(0, -1).map(line => JSON.parse(line));
const entryLine = (seq, ledgerId, record) =>
  JSON.stringify({ kind: 'entry', seq, ledgerId, appendedAt: '2026-11-03T00:00:00.000Z', record }) + '\n';
const codeOf = fn => { try { fn(); return null; } catch (error) { return error.code; } };
/** A clock that answers the given instants in order (then keeps the last). */
const clockOf = (...instants) => { let i = 0; return () => new Date(instants[Math.min(i++, instants.length - 1)]); };
const ticking = start => { let t = Date.parse(start); return () => new Date(t += 1000); };

/** The P server's ledger: the P writer's bytes, copied as-is into a fresh ledger directory. */
function pLedger(which) {
  const ledger = new P.PurposeLedgerFile(ledgerDir());
  fs.copyFileSync(path.join(FIX, META[which].file), ledger.file);
  const bytes = fs.readFileSync(ledger.file);
  assert.equal(sha256(bytes), META[which].sha256, 'the fixture is the P writer\'s output');
  const lines = linesOf(ledger.file);
  assert.ok(lines.slice(1).every(e => e.record.formatVersion === 1 &&
    JSON.stringify(Object.keys(e.record).sort()) === JSON.stringify(V1_RECORD_FIELDS)), 'every record is format 1');
  return { ledger, bytes, lines };
}
/** C01's upgraded server: the P ledger, then one destruction by this tree (unit D). */
async function upgraded() {
  const p = pLedger('closed');
  const d = ended(), state = stateWith([d], { ledgerId: META.ledgerId, ...META.closed.anchor });
  const service = new P.DraftPurposeDisposal(database(state), p.ledger, null, ticking('2026-11-03T01:00:00.000Z'));
  await service.openGate();
  assert.equal((await service.destroy(d.disposalUnitId)).outcome, 'destroyed');
  return { ...p, d, state, after: fs.readFileSync(p.ledger.file), added: linesOf(p.ledger.file).slice(p.lines.length).map(e => e.record) };
}

test('C01 F1/F2 a P server\'s format-1 ledger opens without preparation, keeps its bytes, and new attempts are format 2', async () => {
  const { ledger, bytes, lines, d, state, after, added } = await upgraded();
  assert.equal(lines.at(-1).record.phase, 'completed', 'the P ledger ends closed');
  assert.ok(!state.ended.has(d.disposalUnitId));
  assert.deepEqual(after.subarray(0, bytes.length), bytes, 'the P lines stay byte for byte as the P server wrote them');
  assert.deepEqual(added.map(r => [r.formatVersion, r.phase]), [[2, 'started'], [2, 'completed']]);
  for (const r of added) {
    assert.deepEqual(Object.keys(r).sort(), RECORD_FIELDS);
    assert.deepEqual([r.kind, r.method, r.disposalUnitId], ['operational-deletion', 'operational-store-deletion', d.disposalUnitId]);
  }
  assert.equal(added[0].operationId, added[1].operationId, 'one attempt, one operation');
  // A database restored from before both releases' destructions (A ended, B still live in its author's row, D ended):
  // the P release's completed units and the format-2 one are all re-applied, with no new record.
  const restored = stateWith([ended({ disposalUnitId: META.units.a }), structuredClone(d)], { ledgerId: META.ledgerId, ...META.closed.anchor });
  restored.live.set(META.units.b, { uid: UID, author: AUTHOR, findings: 'SYN live copy' });
  assert.deepEqual([restored.ended.size, restored.live.size], [2, 1], 'the restored copy holds the payloads again');
  const reopened = await new P.DraftPurposeDisposal(database(restored), ledger, null, NOW).openGate();
  assert.equal(reopened.reapplied, 3);
  assert.deepEqual([restored.ended.size, restored.live.size], [0, 0]);
  assert.deepEqual(fs.readFileSync(ledger.file), after, 'a re-application writes nothing');
});

test('C02 F3-F8 a format change the product can tell apart closes with its own code and changes nothing', async () => {
  const base = await upgraded();
  const id = META.ledgerId, n = base.added.length + base.lines.length - 1;   // entries in the base ledger
  const v1 = base.lines[1].record;                                             // a P record (unit A started)
  const v2 = base.added[0];                                                    // this tree's started record (unit D)
  const started = sample({ disposalUnitId: unit() });
  const omit = (record, key) => { const copy = { ...record }; delete copy[key]; return copy; };
  // Each case: records appended to the base ledger as valid envelope lines, and the expected code.
  const cases = [
    ['F3 a format-1 record after format 2', [{ ...v1, disposalUnitId: unit() }], 'PurposeLedgerRecordInvalid'],
    ['F5 a terminal record of another operation', [started, closing({ ...started, operationId: randomUUID() }, 'completed')], 'PurposeLedgerRecordInvalid'],
    ['F5 a terminal record with no started', [closing(sample(), 'completed')], 'PurposeLedgerRecordInvalid'],
    ['F5 a new attempt over an open one', [started, { ...started, operationId: randomUUID() }], 'PurposeLedgerRecordInvalid'],
    ['F5 an operation ID used again', [{ ...v2, disposalUnitId: unit() }], 'PurposeLedgerRecordInvalid'],
    ['F6 an unsupported record format', [{ ...sample(), formatVersion: 3 }], 'PurposeLedgerFormatUnsupported'],
    ['F6 an unsupported format with its own fields', [{ formatVersion: 99, phase: 'started', anything: 'x' }], 'PurposeLedgerFormatUnsupported'],
    ['F6 no format at all', [omit(sample(), 'formatVersion')], 'PurposeLedgerRecordInvalid'],
    ['F6 a format that is not an integer', [{ ...sample(), formatVersion: '2' }], 'PurposeLedgerRecordInvalid'],
    ['F7 a format-2 record without a field', [omit(sample(), 'justifiedDelay')], 'PurposeLedgerRecordInvalid'],
    ['F7 a format-2 record with another field', [{ ...sample(), uid: UID }], 'PurposeLedgerRecordInvalid'],
    ['F8 the format-1 method in format 2', [sample({ method: 'irreversible-permanent-deletion' })], 'PurposeLedgerRecordInvalid'],
    ['F8 a day that is not the occurrence\'s Seoul day', [sample({ day: '2026-11-02' })], 'PurposeLedgerRecordInvalid'],
    ['F8 a timeliness its day contradicts', [sample({ timeliness: 'overdue', delayReasonStatus: 'missing' })], 'PurposeLedgerRecordInvalid'],
    ['F8 a missing reason within the window', [sample({ delayReasonStatus: 'missing' })], 'PurposeLedgerRecordInvalid'],
    ['F8 a reason that is free text', [sample({ occurredAt: '2026-11-08T02:00:00.000Z', day: '2026-11-08', timeliness: 'overdue',
      delayReasonStatus: 'recorded', justifiedDelay: 'SYN patient asked to wait' })], 'PurposeLedgerRecordInvalid'],
  ];
  // Controls: each added record is valid where the targeted rule does not apply.
  const header = base.bytes.toString('utf8').split('\n')[0] + '\n';
  const alone = new P.PurposeLedgerFile(ledgerDir());
  fs.writeFileSync(alone.file, header + entryLine(1, id, { ...v1, disposalUnitId: unit() }));
  assert.equal(alone.read().entries.length, 1, 'F3 control: that format-1 record is valid in a format-1 ledger');
  const pair = new P.PurposeLedgerFile(ledgerDir());
  fs.writeFileSync(pair.file, header + entryLine(1, id, started) + entryLine(2, id, closing(started, 'completed')));
  assert.equal(pair.read().entries.length, 2, 'F4/F5 control: the same started and its own terminal read back');
  assert.equal(codeOf(() => base.ledger.read()), null, 'the base ledger reads');
  const overdue = sample({ occurredAt: '2026-11-08T02:00:00.000Z', day: '2026-11-08', timeliness: 'overdue', delayReasonStatus: 'missing' });
  assert.equal(codeOf(() => { const l = new P.PurposeLedgerFile(ledgerDir()); l.create(id); l.append(id, overdue); }), null,
    'F8 control: an overdue record with a missing reason is valid');
  for (const [label, extra, code] of cases) {
    const ledger = new P.PurposeLedgerFile(ledgerDir());
    const damaged = base.after.toString('utf8') + extra.map((record, i) => entryLine(n + 1 + i, id, record)).join('');
    fs.writeFileSync(ledger.file, damaged);
    assert.equal(codeOf(() => ledger.read()), code, label);
    const state = stateWith([], { ledgerId: id, ...base.state.anchor });
    await assert.rejects(new P.DraftPurposeDisposal(database(state), ledger, null, NOW).openGate(), e => e.code === code, label + ' (gate)');
    assert.equal(fs.readFileSync(ledger.file, 'utf8'), damaged, label + ': the file is unchanged');
  }
  // F4: the P release's open started (unit C, format 1) closed by a format-2 record.
  const open = pLedger('openStarted');
  fs.appendFileSync(open.ledger.file, entryLine(META.openStarted.startedSeq + 1, id, closing(sample({ disposalUnitId: META.units.c }), 'completed')));
  assert.equal(codeOf(() => open.ledger.read()), 'PurposeLedgerRecordInvalid', 'F4');
  // The writer side of the same contract: a new attempt is never written in format 1, an unsupported format never at all.
  const fresh = new P.PurposeLedgerFile(ledgerDir()); fresh.create(id);
  assert.equal(codeOf(() => fresh.append(id, { ...v1, disposalUnitId: unit() })), 'PurposeLedgerRecordInvalid', 'no new format-1 attempt');
  assert.equal(codeOf(() => fresh.append(id, { ...sample(), formatVersion: 3 })), 'PurposeLedgerFormatUnsupported');
  assert.equal(fresh.read().entries.length, 0);
});

test('C03 R1/R4 on the P release\'s open started: R1 closes it in format 1 from the anchor, R4 stays closed and keeps it', async () => {
  // R1: C's deletion committed (its payload is gone, the anchor names C one past the started record), its completed lost.
  const r1 = pLedger('openStarted');
  const last = r1.lines.at(-1);
  assert.deepEqual([last.seq, last.record.formatVersion, last.record.phase, last.record.disposalUnitId],
    [META.openStarted.startedSeq, 1, 'started', META.units.c]);
  const committed = stateWith([], { ledgerId: META.ledgerId, ...META.openStarted.committedAnchor });
  assert.deepEqual([committed.anchor.seq, committed.anchor.lastCompletedUnit], [META.openStarted.startedSeq + 1, META.units.c]);
  assert.ok(!committed.ended.has(META.units.c) && !committed.live.has(META.units.c), 'no payload of C: the deletion committed');
  const service = new P.DraftPurposeDisposal(database(committed), r1.ledger, null, ticking('2026-11-03T05:00:00.000Z'));
  await service.openGate();
  const closed = linesOf(r1.ledger.file);
  assert.deepEqual(fs.readFileSync(r1.ledger.file).subarray(0, r1.bytes.length), r1.bytes);
  const completion = closed.at(-1).record;
  assert.deepEqual(Object.keys(completion).sort(), V1_RECORD_FIELDS, 'closed in its own format (no operation ID)');
  assert.deepEqual({ ...completion, phase: 'started', day: last.record.day }, last.record);
  assert.deepEqual([completion.phase, completion.day], ['completed', '2026-11-02']);
  // After it, a new destruction is format 2.
  const next = ended(); committed.ended.set(next.disposalUnitId, next);
  await service.destroy(next.disposalUnitId);
  assert.deepEqual(linesOf(r1.ledger.file).slice(closed.length).map(e => e.record.formatVersion), [2, 2]);
  // R4: nothing proves C committed (the anchor is still B's, C's payload is still there): closed, nothing written.
  const r4 = pLedger('openStarted');
  const uncommitted = stateWith([ended({ disposalUnitId: META.units.c })], { ledgerId: META.ledgerId, ...META.openStarted.uncommittedAnchor });
  assert.equal(uncommitted.anchor.lastCompletedUnit, META.units.b);
  const other = ended(); uncommitted.ended.set(other.disposalUnitId, other);
  const stranger = new P.DraftPurposeDisposal(database(uncommitted), r4.ledger, null, NOW);
  await assert.rejects(stranger.openGate(), e => e.code === 'PurposeIntentIncomplete');
  await quiet(async () => { await assert.rejects(stranger.destroy(other.disposalUnitId), e => e.code === 'PurposeIntentIncomplete'); });
  await assert.rejects(stranger.sweep(), e => e.code === 'PurposeIntentIncomplete');
  assert.deepEqual(fs.readFileSync(r4.ledger.file), r4.bytes, 'the P record stays the last, no failed is synthesized');
  assert.ok(uncommitted.ended.has(META.units.c) && uncommitted.ended.has(other.disposalUnitId));
});

test('C04 RC3 format 2 records each phase at its own time, failed only for a confirmed rollback, and a retry keeps the due day', async () => {
  // A real ledger answers durable at the real time, never before the record's own time: the synthetic instants are past.
  const past = () => ended({ workSince: new Date('2026-09-30T00:00:00.000Z'), endedAt: new Date('2026-10-01T01:00:00.000Z') });
  const records = (ledger, u) => (ledger.read()?.entries ?? []).map(e => e.record).filter(r => r.disposalUnitId === u);
  // (a) committed: started at the request, completed at the deletion; one operation.
  let row = past(), state = stateWith([row]), ledger = ledgerFor(state.anchor.ledgerId);
  await new P.DraftPurposeDisposal(database(state), ledger, null, clockOf('2026-10-02T00:00:00.000Z', '2026-10-02T00:00:05.000Z')).destroy(row.disposalUnitId);
  assert.ok(!state.ended.has(row.disposalUnitId) && state.anchor.seq === 2 && state.anchor.lastCompletedUnit === row.disposalUnitId);
  let r = records(ledger, row.disposalUnitId);
  assert.deepEqual(r.map(x => [x.phase, x.occurredAt, x.day]), [['started', '2026-10-02T00:00:00.000Z', '2026-10-02'],
    ['completed', '2026-10-02T00:00:05.000Z', '2026-10-02']]);
  assert.equal(new Set(r.map(x => x.operationId)).size, 1);
  assert.deepEqual(r.map(x => [x.dueDay, x.timeliness, x.delayReasonStatus, x.justifiedDelay]),
    [['2026-10-05', 'within-five-days', 'not-required', null], ['2026-10-05', 'within-five-days', 'not-required', null]]);
  // (b) not committed: failed at the time it was confirmed (not the request time), same operation; the retry is a new one.
  row = past(); state = stateWith([row]); ledger = ledgerFor(state.anchor.ledgerId); state.commitFails = 1;
  const service = new P.DraftPurposeDisposal(database(state), ledger, null, clockOf('2026-10-02T00:00:00.000Z',
    '2026-10-02T00:00:05.000Z', '2026-10-02T00:00:09.000Z', '2026-10-06T00:00:00.000Z', '2026-10-06T00:00:01.000Z'));
  await assert.rejects(service.destroy(row.disposalUnitId), /SYN COMMIT FAILURE/);
  assert.ok(state.ended.has(row.disposalUnitId) && state.anchor.seq === 0, 'the deletion rolled back');
  r = records(ledger, row.disposalUnitId);
  assert.deepEqual(r.map(x => [x.phase, x.occurredAt]), [['started', '2026-10-02T00:00:00.000Z'], ['failed', '2026-10-02T00:00:09.000Z']]);
  assert.equal(r[0].operationId, r[1].operationId);
  await service.destroy(row.disposalUnitId);
  r = records(ledger, row.disposalUnitId);
  assert.deepEqual(r.map(x => x.phase), ['started', 'failed', 'started', 'completed']);
  assert.notEqual(r[2].operationId, r[0].operationId, 'a new attempt is a new operation');
  assert.equal(r[3].operationId, r[2].operationId);
  assert.ok(r.every(x => x.dueDay === '2026-10-05'), 'the retry keeps the original due day');
  assert.deepEqual(r.slice(2).map(x => [x.timeliness, x.delayReasonStatus, x.justifiedDelay]),
    [['overdue', 'missing', null], ['overdue', 'missing', null]], 'past the window: overdue, the reason missing, not invented');
  // (c) committed, its judgement unknown: started only; the next match closes the same operation from the anchor.
  row = past(); state = stateWith([row]); ledger = ledgerFor(state.anchor.ledgerId); state.confirmFails = 1;
  const unknown = new P.DraftPurposeDisposal(database(state), ledger, null,
    clockOf('2026-10-02T00:00:00.000Z', '2026-10-02T00:00:05.000Z', '2026-10-02T00:01:00.000Z'));
  await assert.rejects(unknown.destroy(row.disposalUnitId));
  assert.ok(!state.ended.has(row.disposalUnitId) && state.anchor.seq === 2, 'the deletion committed');
  assert.deepEqual(records(ledger, row.disposalUnitId).map(x => x.phase), ['started']);
  assert.equal((await unknown.destroy(row.disposalUnitId)).outcome, 'absent');
  r = records(ledger, row.disposalUnitId);
  assert.deepEqual(r.map(x => [x.phase, x.occurredAt]), [['started', '2026-10-02T00:00:00.000Z'], ['completed', '2026-10-02T00:00:05.000Z']]);
  assert.equal(r[1].operationId, r[0].operationId, 'the same operation, not a new event');
  // (d) rolled back, its judgement unknown: started only; the same process later confirms the rollback (failed, same
  // operation, at that time), then a new operation completes.
  row = past(); state = stateWith([row]); ledger = ledgerFor(state.anchor.ledgerId); state.commitFails = 1; state.confirmFails = 1;
  const rolled = new P.DraftPurposeDisposal(database(state), ledger, null, clockOf('2026-10-02T00:00:00.000Z',
    '2026-10-02T00:00:05.000Z', '2026-10-02T00:02:00.000Z', '2026-10-02T00:03:00.000Z', '2026-10-02T00:03:01.000Z'));
  await assert.rejects(rolled.destroy(row.disposalUnitId));
  assert.ok(state.ended.has(row.disposalUnitId) && state.anchor.seq === 0, 'the deletion rolled back');
  assert.deepEqual(records(ledger, row.disposalUnitId).map(x => x.phase), ['started']);
  await rolled.destroy(row.disposalUnitId);
  r = records(ledger, row.disposalUnitId);
  assert.deepEqual(r.map(x => x.phase), ['started', 'failed', 'started', 'completed']);
  assert.equal(r[1].operationId, r[0].operationId);
  assert.equal(r[1].occurredAt, '2026-10-02T00:02:00.000Z', 'failed when the rollback was confirmed');
  assert.notEqual(r[2].operationId, r[0].operationId);
  // (e) the window's edge between phases: started within, completed past it (Seoul day 11-06).
  row = past(); state = stateWith([row]); ledger = ledgerFor(state.anchor.ledgerId);
  await new P.DraftPurposeDisposal(database(state), ledger, null, clockOf('2026-10-05T14:59:59.000Z', '2026-10-05T15:00:01.000Z')).destroy(row.disposalUnitId);
  r = records(ledger, row.disposalUnitId);
  assert.deepEqual(r.map(x => [x.day, x.timeliness, x.delayReasonStatus]),
    [['2026-10-05', 'within-five-days', 'not-required'], ['2026-10-06', 'overdue', 'missing']]);
});

test('C05 RC5 the deletion and the anchor move commit in one transaction; the judgement reads after it in another; completed follows', async () => {
  const run = async split => {
    const row = ended(), state = stateWith([row]);
    state.txlog = []; state.splitAnchor = split;
    const ledger = ledgerFor(state.anchor.ledgerId), append = ledger.append.bind(ledger);
    ledger.append = (id, record) => { state.txlog.push({ tx: null, text: 'APPEND ' + record.phase }); return append(id, record); };
    const out = await new P.DraftPurposeDisposal(database(state), ledger, null, NOW).destroy(row.disposalUnitId);
    return { out, log: state.txlog };
  };
  const atomic = log => {
    const at = re => log.findIndex(e => re.test(e.text));
    const del = log[at(/^DELETE FROM "ReportDraftPurposeEnd"/)], move = log[at(/^UPDATE "PurposeLedgerAnchor" SET seq/)];
    assert.ok(del && move, 'both writes were made');
    assert.ok(at(/^APPEND started/) < at(/^DELETE FROM "ReportDraftPurposeEnd"/), 'started is durable before the deletion');
    assert.equal(move.tx, del.tx, 'the anchor moves in the deletion\'s transaction');
    const commit = log.findIndex(e => e.tx === del.tx && e.text === 'COMMIT');
    const judge = log.findIndex((e, i) => i > commit && /^SET LOCAL lock_timeout/.test(e.text));
    assert.ok(commit >= 0 && judge > commit, 'the judgement starts after that commit');
    assert.notEqual(log[judge].tx, del.tx);
    assert.ok(at(/^APPEND completed/) > judge, 'completed is written after the judgement');
  };
  const normal = await run(false);
  assert.equal(normal.out.outcome, 'destroyed');
  atomic(normal.log);
  // Counterexample (this harness only): the same product call with the anchor move committed apart. The check fails on it.
  const split = await run(true);
  assert.ok(split.log.some(e => /SET seq/.test(e.text) && e.tx !== null), 'the counterexample reached the anchor move');
  assert.throws(() => atomic(split.log), /anchor moves in the deletion/);
});

test('C06 RC6 the composed gate opens adapters in order, each on its own; the first that closes stops the rest and the listen', async () => {
  const G = require(path.join(api, 'src/emr-retention/retention-gate.ts'));
  const watched = (adapter, calls) => ({ name: adapter.name,
    open: async () => { calls.push(adapter.name + '.open'); return adapter.open(); },
    afterOpen: async () => { calls.push(adapter.name + '.afterOpen'); return adapter.afterOpen(); } });
  const second = (calls, { before, openCode, afterCode } = {}) => ({ name: 'syn-second',
    open: async () => {
      calls.push('syn-second.open');
      if (before) await before();
      if (openCode) throw Object.assign(new Error('SYN second closed'), { code: openCode });
      return 'opened';
    },
    afterOpen: async () => {
      calls.push('syn-second.afterOpen');
      if (afterCode) throw Object.assign(new Error('SYN sweep'), { code: afterCode });
      return { unsettled: 0 };
    } });
  const quietLog = { log: () => {}, error: () => {} };
  const start = async (adapters, calls) => {
    try { await new G.RetentionGate(adapters).open(quietLog); calls.push('listen'); return null; } catch (error) { return error; }
  };
  // (a) both open: opens in order, then each sweep in order, then the listen.
  let row = ended(), state = stateWith([row]), ledger = ledgerFor(state.anchor.ledgerId), calls = [];
  let p = new P.DraftPurposeDisposal(database(state), ledger, null, NOW);
  assert.equal(await start([watched(P.draftPurposeAdapter(() => p), calls), second(calls)], calls), null);
  assert.deepEqual(calls, ['draft-purpose.open', 'syn-second.open', 'draft-purpose.afterOpen', 'syn-second.afterOpen', 'listen']);
  assert.ok(!state.ended.has(row.disposalUnitId), 'the draft purpose sweep ran after every adapter opened');
  // (b) the second closes: no sweep of anyone, no listen; the P ended work is still pending.
  row = ended(); state = stateWith([row]); ledger = ledgerFor(state.anchor.ledgerId); calls = [];
  p = new P.DraftPurposeDisposal(database(state), ledger, null, NOW);
  let error = await start([watched(P.draftPurposeAdapter(() => p), calls), second(calls, { openCode: 'SynSecondClosed' })], calls);
  assert.deepEqual([error?.adapter, error?.code], ['syn-second', 'SynSecondClosed']);
  assert.deepEqual(calls, ['draft-purpose.open', 'syn-second.open']);
  assert.ok(state.ended.has(row.disposalUnitId));
  // (c) the draft purpose adapter closes (another ledger): the second is never opened.
  calls = [];
  p = new P.DraftPurposeDisposal(database(stateWith([])), ledgerFor(randomUUID()), null, NOW);
  error = await start([watched(P.draftPurposeAdapter(() => p), calls), second(calls)], calls);
  assert.deepEqual([error?.adapter, error?.code], ['draft-purpose', 'PurposeLedgerMismatch']);
  assert.match(error.message, /draft-purpose/); assert.match(error.message, /PurposeLedgerMismatch/);
  assert.deepEqual(calls, ['draft-purpose.open']);
  // An adapter whose service cannot even be built (no ledger directory) is that adapter's closure, before any other.
  calls = [];
  error = await start([watched(P.draftPurposeAdapter(() => new P.DraftPurposeDisposal(database(stateWith([])),
    new P.PurposeLedgerFile(P.purposeLedgerDirectory({})), null, NOW)), calls), second(calls)], calls);
  assert.deepEqual([error?.adapter, error?.code, calls], ['draft-purpose', 'PurposeLedgerDirectoryRequired', ['draft-purpose.open']]);
  // (d) the draft purpose re-application commits, then the second closes: that commit stays (each adapter's own
  // transaction), the server does not listen, and the next start finds nothing more to re-apply.
  const restored = await restoredCompleted();
  const db = database(restored.state);
  let observed = null;
  calls = [];
  error = await start([watched(P.draftPurposeAdapter(() => new P.DraftPurposeDisposal(db, restored.ledger, null, NOW)), calls),
    second(calls, { openCode: 'SynSecondClosed', before: async () => {
      observed = { gone: !restored.state.ended.has(restored.row.disposalUnitId),
        judged: await P.judgeCommit(db, { kind: 'reapplied', units: [restored.row.disposalUnitId] }, null) };
    } })], calls);
  assert.deepEqual(observed, { gone: true, judged: 'committed' }, 'the first adapter\'s re-application had committed before the second closed');
  assert.deepEqual([error?.adapter, calls.includes('listen')], ['syn-second', false]);
  assert.ok(!restored.state.ended.has(restored.row.disposalUnitId), 'the committed re-application is not undone');
  const again = new P.DraftPurposeDisposal(db, restored.ledger, null, NOW), results = [], realOpen = again.openGate.bind(again);
  again.openGate = async () => { const out = await realOpen(); results.push(out); return out; };
  calls = [];
  assert.equal(await start([P.draftPurposeAdapter(() => again), second(calls)], calls), null);
  assert.equal(results[0].reapplied, 0, 'idempotent at the next start');
  assert.deepEqual(fs.readFileSync(restored.ledger.file), restored.bytes);
  // (e) after every open: a work under a live hold is a normal open unit, nothing reported; a destruction the sweep
  // could not finish is reported and the server still opens (as before the gate was composed); a sweep that throws
  // closes it.
  row = ended(); state = stateWith([row]); ledger = ledgerFor(state.anchor.ledgerId); calls = [];
  state.holds = hold(P.draftRecordId(row.uid, row.author), '2026-11-01T00:30:00.000Z');
  p = new P.DraftPurposeDisposal(database(state), ledger, null, NOW);
  let errors = [];
  await new G.RetentionGate([P.draftPurposeAdapter(() => p), second(calls)]).open({ log: () => {}, error: (...a) => errors.push(a.join(' ')) });
  assert.ok(state.log.includes('holds'), 'the sweep read the hold');
  assert.ok(state.ended.has(row.disposalUnitId), 'held, not destroyed and not a closure');
  assert.deepEqual([phasesOf(ledger, row.disposalUnitId), errors], [[], []]);
  row = ended(); state = stateWith([row]); ledger = ledgerFor(state.anchor.ledgerId); calls = []; errors = [];
  p = new P.DraftPurposeDisposal(database(state), ledger, null, NOW);
  const real = P.draftPurposeAdapter(() => p);
  // The sweep's deletion fails to commit (set after the open, whose own transaction must commit).
  const failing = { name: real.name, open: real.open, afterOpen: async () => { state.commitFails = 1; return real.afterOpen(); } };
  await quiet(() => new G.RetentionGate([failing, second(calls)]).open({ log: () => {}, error: (...a) => errors.push(a.join(' ')) }));
  assert.equal(state.commitFails, 0, 'the failing commit was reached');
  assert.ok(state.ended.has(row.disposalUnitId));
  assert.deepEqual(phasesOf(ledger, row.disposalUnitId), ['started', 'failed']);
  assert.equal(errors.length, 1, 'the unsettled work is reported');
  row = ended(); state = stateWith([row]); ledger = ledgerFor(state.anchor.ledgerId); calls = [];
  p = new P.DraftPurposeDisposal(database(state), ledger, null, NOW);
  error = await start([watched(P.draftPurposeAdapter(() => p), calls), second(calls, { afterCode: 'SynSweepFailed' })], calls);
  assert.deepEqual([error?.adapter, error?.code], ['syn-second', 'SynSweepFailed']);
  assert.deepEqual(calls, ['draft-purpose.open', 'syn-second.open', 'draft-purpose.afterOpen', 'syn-second.afterOpen']);
  // The server composes its gate once.
  G.composeRetentionGate([second([])]);
  assert.throws(() => G.composeRetentionGate([second([])]), /RetentionGateAlreadyComposed/);
});

test('C07 RC4 a format-1 completion is not counted as a format-2 operational completion', async () => {
  const v1 = pLedger('closed').lines.at(-1).record;
  const { added } = await upgraded();
  const v2 = added.at(-1);
  assert.deepEqual([v1.phase, v2.phase], ['completed', 'completed']);
  assert.equal(codeOf(() => A.confirmDestruction('syn-batch', [v1], 'privacy-officer', '2026-11-04T00:00:00.000Z')), 'OperationalDeletionRequired');
  const confirmed = A.confirmDestruction('syn-batch', [v2], 'privacy-officer', '2026-11-04T00:00:00.000Z');
  assert.deepEqual(confirmed.disposalUnitIds, [v2.disposalUnitId]);
  // The method names the operational store only; nothing here says a backup or a WAL segment is gone.
  assert.equal(v2.method, 'operational-store-deletion');
  assert.doesNotMatch(A.PRODUCT_DEFAULTS.disposal, /irreversible|permanent/);
});

// ── CD-09-C C-F4: the commit judgement every retention unit shares (commit-judgement.ts), with P as its consumer ──

/** A database double for the shared judgement: each transaction's statements in order, and where it can fail. */
function judgeDb(fail = null) {
  const log = [];
  const tx = {
    $executeRaw: async (strings) => { log.push(strings.join('?')); if (fail === 'lock') throw Object.assign(new Error('lock timeout'), { code: 'P2010' }); return 0; },
    $queryRaw: async (strings) => { log.push(strings.join('?')); return []; },
  };
  return { log, $transaction: async (work) => {
    log.push('BEGIN');
    if (fail === 'connect') throw new Error('connection lost');
    const value = await work(tx);
    if (fail === 'commit') throw new Error('error answering COMMIT');
    log.push('COMMIT'); return value;
  } };
}

test('C08 C-F4 the shared judgement reads in a new transaction with a bounded lock wait, and anything it cannot read is unknown', async () => {
  const J = require(path.join(api, 'src/emr-retention/commit-judgement.ts'));
  for (const outcome of ['committed', 'not-committed', 'unknown']) {
    const db = judgeDb();
    let seen = null;
    assert.equal(await J.judgeSettled(db, async tx => { seen = db.log.slice(); await tx.$queryRaw(['SELECT 1']); return outcome; }), outcome);
    // The reader runs after the lock wait is bounded, inside a transaction of its own.
    assert.deepEqual(seen, ['BEGIN', "SET LOCAL lock_timeout = '3s'"]);
    assert.deepEqual(db.log, ['BEGIN', "SET LOCAL lock_timeout = '3s'", 'SELECT 1', 'COMMIT']);
  }
  // The read cannot be made: the lock not granted in time, a lost connection, an error answering; or the reader throws, or
  // answers something that is not one of the three. Each is unknown, never committed or not committed.
  let reached = 0;
  for (const fail of ['lock', 'connect', 'commit']) {
    assert.equal(await J.judgeSettled(judgeDb(fail), async () => { reached++; return 'not-committed'; }), 'unknown', fail);
  }
  assert.equal(reached, 1, 'only the failed COMMIT reached the reader');
  assert.equal(await J.judgeSettled(judgeDb(), async () => { throw new Error('row read failed'); }), 'unknown');
  assert.equal(await J.judgeSettled(judgeDb(), async () => true), 'unknown');
});

test('C08b C-F4 the destroyer answer A receives follows the judgement: receipt, a confirmed failure, or unknown', async () => {
  const J = require(path.join(api, 'src/emr-retention/commit-judgement.ts'));
  const receipt = { completedAt: '2026-11-01T02:00:00.000Z', method: 'operational-store-deletion' };
  const confirmed = new Error('rolled back');
  for (const [outcome, phases] of [['committed', ['started', 'completed']], ['not-committed', ['started', 'failed']], ['unknown', ['started']]]) {
    const store = journal(), stored = { payload: true };
    let answer = null;
    try {
      await P.decidePurposeEnd(store, ended(), noFacts(), receipt.completedAt, async () => {
        if (outcome === 'committed') stored.payload = false;
        return J.destroyerAnswer(outcome, receipt, () => confirmed);
      });
    } catch (error) { answer = error; }
    assert.equal(stored.payload, outcome !== 'committed', outcome);
    assert.deepEqual(store.lines.map(l => l.phase), phases, outcome);
    if (outcome === 'not-committed') assert.equal(answer, confirmed);
    if (outcome === 'unknown') assert.ok(answer instanceof A.CommitOutcomeUnknown);
  }
});

test('C08c C-F4 P judges through the shared judgement: its read is bounded and a read that fails is unknown', async () => {
  const target = { kind: 'destroyed', unit: unit(), startedSeq: 1, before: { seq: 0, lastCompletedUnit: null } };
  for (const fail of ['lock', 'connect', 'commit']) assert.equal(await P.judgeCommit(judgeDb(fail), target, null), 'unknown', fail);
  const db = judgeDb();
  await P.judgeCommit(db, { kind: 'reapplied', units: [unit()] }, null);
  assert.deepEqual(db.log.slice(0, 2), ['BEGIN', "SET LOCAL lock_timeout = '3s'"]);
  assert.equal(db.log.at(-1), 'COMMIT');
});