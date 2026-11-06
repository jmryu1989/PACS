'use strict';
/* CD-09-D compiled report destruction over a real disposable PostgreSQL: the kin-api image's /app/dist report retention unit
 * (api/src/emr-retention/report-retention.ts) run as the runtime role kin_runtime, its migration, the signature function,
 * the external ledger in a test-owned directory, and the server's retention gate. Every outcome is read back from the
 * database and the ledger file; nothing in the product exists for this file.
 *
 * Conditions (order-cd-09d-plan-20261105.md, reduced D1~D16, with the plan review's E1~E4):
 *   PG01 E3/D15  the first start after the D migration binds the ledger even with existing reports; a restart before any
 *                destruction opens; a run before the binding is refused.
 *   PG02 D15     a copy without its ledger (DB-only), a ledger of another database (ledger-only) and a backup from before
 *                the migration migrated again stay closed.
 *   PG03 D2/E4   one transaction: rs D, unit emptied, epoch moved, versions/head/signatures/operations deleted, anchor moved;
 *                the runtime cannot delete signatures directly and the function refuses a report that is not destroyed.
 *   PG04 D2      a signature deletion that is refused rolls everything back (started + failed, report whole).
 *   PG05 D3      a COMMIT that fails (deferred constraint) is judged not committed: failed, report whole.
 *   PG06 D5/E1   a study whose StudyState, Report or ReportVersion row, hold lock, fixed-record lock, or signing-operation or
 *                signature row another connection holds is deferred at once (busy), nothing recorded; released, destroyed.
 *   PG07 D6/D8/D4 a live draft of another author or an applied Related insertion keeps the expired report; the outcome names
 *                its due day and that it is overdue.
 *   PG08 D1      a report with a version the server did not sign is kept unconfirmed; the run is not complete; a stored
 *                approval whose summary time disagrees with its envelope is kept unconfirmed, and so is an expired version
 *                whose stored structured item or citation is no longer the row its signature signed.
 *   PG09 D13/E2  a destruction whose answer is lost after its commit is completed by the next run under the same operation
 *                ID, without a second started record; the attempt is read back by that ID.
 *   PG10 D14     a restored older copy gets the completed destruction re-applied by the gate; a re-application whose
 *                confirmation is lost keeps the gate closed.
 *   PG11 mirror  (2026-11-06) every record reaches the ledger mirror; a lost ledger file is restored from it only after the
 *                whole gate passed on it (D15 ID, anchor length, D14 re-application confirmed); otherwise closed, nothing created.
 *
 * KIN_REPORT_RETENTION_DATABASE_URL names a disposable server's database kin_report_retention_test (provisioned EMR roles,
 * no table yet): the image's migrations are applied here with `prisma migrate deploy`. Container only. Synthetic data only.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const DATABASE = 'kin_report_retention_test';
const { PrismaClient } = require('/app/node_modules/@prisma/client');
const M = require('/app/dist/emr-contract/composition');
const CTX = require('/app/dist/emr-runtime/context');
const R = require('/app/dist/emr-retention/report-retention');
const SWEEP = require('/app/dist/emr-retention/report-retention-sweep');
const { RetentionGate } = require('/app/dist/emr-retention/retention-gate');
const C = require('/app/dist/emr-signature/server-crypto');
M.composeEmrAdapters(CTX.runtimeAdapters);

// The stored approval native signing writes (emr-report/native-signing.ts → online-store.ts): the current signServerPayload
// over the whole saved version row (seedReport), signed with the clock set to the seeded time, and the key registration retained beside it.
const KEYS = C.generateServerKeyPair();
const SIGNER = { issuer: 'SYN', subject: 'syn-reader', id: 'syn-reader' };
const KEY = { kid: 'SYN-KID', publicKey: KEYS.publicKey, status: 'active', registeredAt: '2010-01-01T00:00:00.000Z', endedAt: null,
  doctor: { identity: SIGNER, identityRegistrationId: 'SYN-REG', institutionId: 'SYN-SITE', canSign: true } };
const SIGNING_ACTION = { approve: 'approve-sign', addendum: 'addendum', reset: 'cancel', save: 'approve-sign' };
function approval(row, signedAt, operationId) {
  const content = { formatVersion: 'emr-signature/1', text: { kind: 'clinical-entry', body: JSON.stringify(row) },
    patient: { linkId: 'SYN-LINK', patientId: 'SYN-PATIENT', assigningAuthority: 'SYN-SITE' }, studyId: row.uid,
    managingInstitutionId: 'SYN-SITE', actingInstitutionId: 'SYN-SITE', recordKind: 'report-version', recordId: row.uid,
    versionId: String(row.version), author: SIGNER, signer: SIGNER, identityRegistrationId: 'SYN-REG', action: SIGNING_ACTION[row.action],
    previousVersion: row.version > 1 ? { recordId: row.uid, versionId: String(row.version - 1), sha256: '0'.repeat(64) } : null,
    attachments: [], reason: row.reason };
  test.mock.timers.enable({ apis: ['Date'], now: Date.parse(signedAt) });
  let signed;
  try { signed = C.signServerPayload(content, KEY.kid, KEYS.privateKey); } finally { test.mock.timers.reset(); }
  return { ...signed, operationId, recordId: row.uid, versionId: String(row.version), kid: KEY.kid, doctorId: SIGNER.id,
    institutionId: 'SYN-SITE', keyAtSigning: KEY };
}

let prepared = null;
function database() {
  prepared ??= (async () => {
    const url = process.env.KIN_REPORT_RETENTION_DATABASE_URL;
    assert.ok(url, 'set KIN_REPORT_RETENTION_DATABASE_URL to the disposable ' + DATABASE + ' database');
    assert.equal(new URL(url).pathname, '/' + DATABASE, 'refusing any database but the disposable ' + DATABASE);
    const witness = new PrismaClient({ datasources: { db: { url } } });
    await witness.$connect();
    const [{ tables }] = await witness.$queryRawUnsafe(`SELECT count(*)::int AS tables FROM pg_tables WHERE schemaname = 'public'`);
    assert.equal(tables, 0, 'refusing a database that already holds tables');
    execFileSync('/app/node_modules/.bin/prisma', ['migrate', 'deploy', '--schema', '/app/prisma/schema.prisma'],
      { cwd: '/app', env: { ...process.env, DATABASE_URL: url, HOME: os.tmpdir(), CHECKPOINT_DISABLE: '1' }, stdio: 'pipe' });
    const runtime = new URL(url); runtime.username = 'kin_runtime'; runtime.password = '';
    const db = new PrismaClient({ datasources: { db: { url: runtime.toString() } } });
    await db.$connect();
    const [{ who }] = await db.$queryRawUnsafe('SELECT current_user AS who');
    assert.equal(who, 'kin_runtime');
    await witness.$executeRaw`INSERT INTO emr_signing.doctor_key(kid, institution_id, doctor_id, status, registration)
      VALUES ('SYN-KID', 'SYN-SITE', 'syn-reader', 'active', ${JSON.stringify(KEY)}::jsonb)`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-ledger-'));
    return { witness, db, dir, ledger: () => new R.ReportLedgerFile(dir) };
  })();
  return prepared;
}
test.after(async () => {
  if (!prepared) return;
  const { witness, db } = await prepared;
  await db.$disconnect(); await witness.$disconnect();
});

const OLD = '2015-01-05T01:00:00.000Z';
const at = (base, seconds) => new Date(Date.parse(base) + seconds * 1000).toISOString();
const hex = n => n.toString(16).padStart(64, '0');
let studies = 0;

/** One study with a report: versions [action, signed] in order, each signed a minute after the previous. */
async function seedReport(witness, { rs = 'A', versions = [['approve', true]], base = OLD } = {}) {
  const uid = `2.25.990${process.pid}${++studies}`;
  await witness.$executeRaw`INSERT INTO "StudyState"(uid, rs, "institutionId", "repDoc", confirm, "updatedAt")
    VALUES (${uid}, ${rs}, 'SYN-SITE', 'syn-reader', ${base.slice(0, 10)}, now())`;
  let n = 0;
  for (const [action, signed] of versions) {
    n += 1;
    const signedAt = at(base, 60 * n), operationId = randomUUID(), findings = 'SYN findings ' + n;
    // The row as report-commit.ts saves it (citation and structured testimony included) and native signing signs it: the
    // whole saved row the store hands back, never a hand-picked subset of its fields.
    const row = await witness.reportVersion.create({ data: { uid, version: n, action, findings, conclusion: 'SYN conclusion',
      recommendation: '', reason: null, author: 'syn-reader', at: new Date(at(signedAt, -1)),
      citations: [{ v: 2, cid: `syn-c${n}`, field: 'findings', findingId: 'syn-f', findingRevision: 1, sourceIndex: 0, sourceRef: {},
        linkStateAtInsert: 'current', headRevisionAtInsert: 1, insertedText: findings, insertedAt: at(signedAt, -2), insertedBy: 'syn-reader' }],
      structured: [{ v: 1, sid: `syn-s${n}`, field: 'findings', templateId: 'GEN-1', templateRevision: 1, itemCode: 'TECHNIQUE',
        valueType: 'text', value: 'SYN', renderedText: findings, enteredAt: at(signedAt, -2), enteredBy: 'syn-reader' }] } });
    if (!signed) continue;
    const outcome = JSON.stringify(approval(row, signedAt, operationId));
    await witness.$executeRaw`INSERT INTO emr_signing.signed_version(record_id, version_id, kid, outcome) VALUES (${uid}, ${String(n)}, 'SYN-KID', ${outcome}::jsonb)`;
    await witness.$executeRaw`INSERT INTO emr_signing.operation(operation_id, fingerprint, outcome) VALUES (${operationId}, 'syn', ${outcome}::jsonb)`;
  }
  await witness.$executeRaw`INSERT INTO "Report"(uid, findings, conclusion, recommendation, version, "updatedBy", "updatedAt")
    VALUES (${uid}, ${'SYN findings ' + n}, 'SYN conclusion', '', ${n}, 'syn-reader', now())`;
  const [state] = await witness.$queryRaw`SELECT "reportUnit" AS unit, "draftEpoch"::text AS epoch FROM "StudyState" WHERE uid = ${uid}`;
  return { uid, unit: state.unit, epoch: state.epoch };
}
async function stored(witness, uid) {
  const [row] = await witness.$queryRaw`SELECT s.rs, s."reportUnit" AS unit, s."repDoc", s.confirm, s."draftEpoch"::text AS epoch,
    (SELECT count(*)::int FROM "Report" WHERE uid = ${uid}) AS heads,
    (SELECT count(*)::int FROM "ReportVersion" WHERE uid = ${uid}) AS versions,
    (SELECT count(*)::int FROM emr_signing.signed_version WHERE record_id = ${uid}) AS signatures,
    (SELECT count(*)::int FROM emr_signing.operation WHERE outcome ->> 'recordId' = ${uid}) AS operations
    FROM "StudyState" s WHERE s.uid = ${uid}`;
  return row;
}
const anchor = async witness => (await witness.$queryRaw`SELECT "ledgerId"::text AS "ledgerId", seq, initialized, "lastCompletedUnit"
  FROM "ReportLedgerAnchor" WHERE id = 1`)[0];
const entries = ledger => ledger.read()?.entries ?? [];
const quiet = { log() {}, error() {} };

/** A transaction of another connection that holds `sql`'s lock until released. */
async function holding(witness, sql) {
  let release, held;
  const released = new Promise(resolve => { release = resolve; });
  const taken = new Promise(resolve => { held = resolve; });
  const work = witness.$transaction(async tx => { await tx.$queryRawUnsafe(sql); held(); await released; }, { maxWait: 10000, timeout: 60000 });
  await Promise.race([taken, work]);
  return async () => { release(); await work; };
}
/** The runtime client whose first transaction opened after `lost()` became true fails: an answer lost after a commit. */
function losingAnswer(db, lost) {
  let armed = true;
  return new Proxy(db, { get(target, property) {
    if (property === '$transaction') return async (...args) => {
      if (armed && await lost()) { armed = false; throw new Error('synthetic: the read after the commit got no answer'); }
      return target.$transaction(...args);
    };
    const value = target[property];
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

test('PG01 E3: the first start binds the ledger beside existing reports; a restart before any destruction opens', async () => {
  const { witness, db, ledger } = await database();
  const existing = await seedReport(witness, { base: new Date().toISOString() });
  const before = await anchor(witness);
  assert.equal(before.initialized, false);
  await assert.rejects(new R.ReportRetention(db, ledger()).destroy(existing.unit), { code: 'ReportLedgerInitializationRequired' });
  assert.equal(ledger().read(), null);
  assert.deepEqual(await new R.ReportRetention(db, ledger()).openGate(), { bound: true, reapplied: 0, units: 0 });
  assert.equal(ledger().read().ledgerId, before.ledgerId);
  assert.equal((await anchor(witness)).initialized, true);
  // A restart before the first destruction: the same ledger, nothing to re-apply; the report is untouched.
  assert.deepEqual(await new R.ReportRetention(db, ledger()).openGate(), { bound: false, reapplied: 0, units: 0 });
  const kept = await stored(witness, existing.uid);
  assert.equal(kept.rs, 'A'); assert.equal(kept.versions, 1); assert.equal(kept.signatures, 1);
  // The server's sweep leaves a report not yet due alone.
  const swept = await new R.ReportRetention(db, ledger()).sweep();
  assert.equal(swept.find(r => r.unit === existing.unit), undefined);
});

test('PG02 D15: a copy without its ledger, another database\'s ledger and a re-migrated pre-migration backup stay closed', async () => {
  const { witness, db, dir, ledger } = await database();
  const file = path.join(dir, R.REPORT_LEDGER_FILE), saved = file + '.saved';
  const gate = () => new RetentionGate([R.reportRetentionAdapter(() => new R.ReportRetention(db, ledger()))]).open(quiet);
  fs.renameSync(file, saved);
  try { await assert.rejects(gate(), { name: 'RetentionGateClosed', adapter: 'report-retention', code: 'ReportLedgerMissing' }); }
  finally { fs.renameSync(saved, file); }
  const original = await anchor(witness);
  try {
    await witness.$executeRaw`UPDATE "ReportLedgerAnchor" SET "ledgerId" = gen_random_uuid() WHERE id = 1`;
    await assert.rejects(gate(), { code: 'ReportLedgerMismatch' });
    // A backup from before the D migration, migrated again: a new anchor ID, never initialized, beside the real ledger.
    await witness.$executeRaw`UPDATE "ReportLedgerAnchor" SET "ledgerId" = gen_random_uuid(), initialized = false WHERE id = 1`;
    await assert.rejects(gate(), { code: 'ReportLedgerMismatch' });
  } finally {
    await witness.$executeRaw`UPDATE "ReportLedgerAnchor" SET "ledgerId" = ${original.ledgerId}::uuid, initialized = true WHERE id = 1`;
  }
  await gate();
});

test('PG03 D2/E4: one transaction marks the study destroyed and deletes versions, head, signatures and operations; the runtime cannot do it apart', async () => {
  const { witness, db, ledger } = await database();
  const r = await seedReport(witness, { versions: [['approve', true], ['addendum', true]] });
  // The runtime role has no DELETE on the signing tables, and the function refuses a report that is not destroyed.
  await assert.rejects(db.$executeRawUnsafe(`DELETE FROM emr_signing.signed_version WHERE record_id = '${r.uid}'`), /permission denied/);
  await assert.rejects(db.$queryRawUnsafe(`SELECT emr_signing.destroy_report_signatures('${r.uid}')::int AS n`), /ReportNotDestroyed/);
  const before = entries(ledger()).length;
  const out = await new R.ReportRetention(db, ledger()).destroy(r.unit);
  assert.equal(out.outcome, 'destroyed');
  const after = await stored(witness, r.uid);
  assert.deepEqual({ ...after, epoch: undefined }, { rs: 'D', unit: null, repDoc: null, confirm: null, epoch: undefined,
    heads: 0, versions: 0, signatures: 0, operations: 0 });
  assert.notEqual(after.epoch, r.epoch, 'a new draft epoch: no write of the old one lands');
  const lines = entries(ledger()).slice(before);
  assert.deepEqual(lines.map(e => [e.record.phase, e.record.disposalUnitId, e.record.operationId]),
    [['started', r.unit, out.operationId], ['completed', r.unit, out.operationId]]);
  assert.equal(lines[1].record.partCount, 2);
  assert.ok(!JSON.stringify(lines).includes(r.uid), 'the ledger names the unit only');
  const a = await anchor(witness);
  assert.equal(a.seq, out.seq); assert.equal(a.lastCompletedUnit, r.unit);
  // The study row stays (D9); the completed unit is absent on the next attempt.
  assert.deepEqual(await new R.ReportRetention(db, ledger()).destroy(r.unit), { unit: r.unit, outcome: 'absent' });
});

test('PG04 D2: a refused signature deletion rolls the whole destruction back; started then failed, the report whole', async () => {
  const { witness, db, ledger } = await database();
  const r = await seedReport(witness);
  const whole = await stored(witness, r.uid), before = entries(ledger()).length;
  await witness.$executeRawUnsafe(`CREATE FUNCTION public.syn_refuse_signature_delete() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic refusal of the signature deletion'; END $$`);
  await witness.$executeRawUnsafe(`CREATE TRIGGER syn_refuse BEFORE DELETE ON emr_signing.signed_version FOR EACH ROW
    EXECUTE FUNCTION public.syn_refuse_signature_delete()`);
  try {
    const error = await new R.ReportRetention(db, ledger()).destroy(r.unit).then(() => null, e => e);
    assert.ok(error, 'the destruction is refused');
    assert.deepEqual(await stored(witness, r.uid), whole);
    const lines = entries(ledger()).slice(before);
    assert.deepEqual(lines.map(e => e.record.phase), ['started', 'failed']);
    assert.equal(error.operationId, lines[0].record.operationId);
  } finally {
    await witness.$executeRawUnsafe('DROP TRIGGER syn_refuse ON emr_signing.signed_version');
    await witness.$executeRawUnsafe('DROP FUNCTION public.syn_refuse_signature_delete()');
  }
  assert.equal((await new R.ReportRetention(db, ledger()).destroy(r.unit)).outcome, 'destroyed');
});

test('PG05 D3: a COMMIT that fails after the transaction answered is judged not committed: failed, the report whole', async () => {
  const { witness, db, ledger } = await database();
  const r = await seedReport(witness);
  const whole = await stored(witness, r.uid), before = entries(ledger()).length, anchored = await anchor(witness);
  await witness.$executeRawUnsafe(`CREATE FUNCTION public.syn_fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic failure at COMMIT'; END $$`);
  await witness.$executeRawUnsafe(`CREATE CONSTRAINT TRIGGER syn_fail_commit AFTER UPDATE ON "ReportLedgerAnchor"
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.syn_fail_commit()`);
  try {
    await assert.rejects(new R.ReportRetention(db, ledger()).destroy(r.unit));
    assert.deepEqual(await stored(witness, r.uid), whole);
    assert.deepEqual(entries(ledger()).slice(before).map(e => e.record.phase), ['started', 'failed']);
    assert.deepEqual(await anchor(witness), anchored);
  } finally {
    await witness.$executeRawUnsafe('DROP TRIGGER syn_fail_commit ON "ReportLedgerAnchor"');
    await witness.$executeRawUnsafe('DROP FUNCTION public.syn_fail_commit()');
  }
  assert.equal((await new R.ReportRetention(db, ledger()).destroy(r.unit)).outcome, 'destroyed');
});

test('PG06 D5/E1: any row or lock of the study another connection holds defers it at once; released, it is destroyed', async () => {
  const { witness, db, ledger } = await database();
  const r = await seedReport(witness);
  const whole = await stored(witness, r.uid), before = entries(ledger()).length;
  const locks = [
    `SELECT uid FROM "StudyState" WHERE uid = '${r.uid}' FOR UPDATE`,
    `SELECT uid FROM "Report" WHERE uid = '${r.uid}' FOR UPDATE`,
    // A critical result or a question pinning a version takes this lock through its foreign key.
    `SELECT id FROM "ReportVersion" WHERE uid = '${r.uid}' FOR KEY SHARE`,
    `SELECT pg_advisory_xact_lock(hashtextextended('kin-hold:${r.uid}', 0))::text`,
    `SELECT pg_advisory_xact_lock(hashtextextended('["emr-fixed-record","${r.uid}"]', 0))::text`,
    // Review F2: the rows the signature deletion removes. A signing retry holds its operation row this way
    // (emr-report/online-store.ts operation()); nothing may be recorded before they are taken.
    `SELECT operation_id FROM emr_signing.operation WHERE outcome ->> 'recordId' = '${r.uid}' FOR UPDATE`,
    `SELECT record_id FROM emr_signing.signed_version WHERE record_id = '${r.uid}' FOR UPDATE`,
  ];
  for (const sql of locks) {
    const release = await holding(witness, sql);
    try {
      const started = Date.now();
      const out = await new R.ReportRetention(db, ledger()).destroy(r.unit);
      assert.deepEqual(out, { unit: r.unit, outcome: 'deferred', code: 'busy' }, sql);
      assert.ok(Date.now() - started < 3000, 'deferred without waiting for the lock: ' + sql);
      assert.deepEqual(await stored(witness, r.uid), whole);
      assert.equal(entries(ledger()).length, before, 'nothing recorded');
    } finally { await release(); }
  }
  assert.equal((await new R.ReportRetention(db, ledger()).destroy(r.unit)).outcome, 'destroyed');
});

test('PG07 D6/D8/D4: another author\'s live draft or an applied Related insertion keeps the expired report, reported overdue with its due day', async () => {
  const { witness, db, ledger } = await database();
  const r = await seedReport(witness);
  const whole = await stored(witness, r.uid), before = entries(ledger()).length;
  await witness.$executeRaw`INSERT INTO "ReportDraft"(uid, author, findings, present, "updatedAt", "workUnit", "workSince", "workIntent")
    VALUES (${r.uid}, 'syn-other', 'SYN other draft', true, now(), ${'disposal:' + randomUUID()}, now(), 'addendum')`;
  // Signed 2015-01-05 10:01 KST: 5 years end at 2020-01-05 00:00 KST; the fifth day of the window is 2020-01-09.
  assert.deepEqual(await new R.ReportRetention(db, ledger()).destroy(r.unit),
    { unit: r.unit, outcome: 'held', code: 'live-draft', dueDay: '2020-01-09', overdue: true });
  await witness.$executeRaw`DELETE FROM "ReportDraft" WHERE uid = ${r.uid}`;
  await witness.$executeRaw`INSERT INTO "ReportDraftInsertReceipt"("insertRequestId", "targetUid", "ownerInstitution", "ownerSub",
    "ownerAuthor", "requestHash", "proposalHash", "expectedEpoch", "expectedRevision", "sourceUid", "sourceVersion", "targetBaseVersion",
    section, state, "appliedRevision", "updatedAt") VALUES (${randomUUID()}::uuid, '2.25.990other', 'SYN-SITE', 'syn-sub', 'syn-other',
    ${hex(1)}, ${hex(2)}, ${randomUUID()}::uuid, 1, ${r.uid}, 1, 0, 'findings', 'applied', 2, now())`;
  const held = await new R.ReportRetention(db, ledger()).destroy(r.unit);
  assert.equal(held.outcome, 'held'); assert.equal(held.code, 'related');
  assert.deepEqual(await stored(witness, r.uid), whole);
  assert.equal(entries(ledger()).length, before, 'nothing recorded');
});

test('PG08 D1: a report with a version the server did not sign is kept unconfirmed and the run is not complete', async () => {
  const { witness, db, dir } = await database();
  const r = await seedReport(witness, { versions: [['save', false], ['approve', true]] });
  const whole = await stored(witness, r.uid);
  const report = await SWEEP.runReportRetentionSweep(db, dir);
  assert.deepEqual(report.results.find(x => x.unit === r.unit), { unit: r.unit, outcome: 'unconfirmed', code: 'unsigned-version', dueDay: null, overdue: null });
  assert.equal(report.complete, false);
  assert.deepEqual(await stored(witness, r.uid), whole);
  // Review F1: a stored approval whose summary claims an older time than its envelope signed is not read as expired.
  const recent = await seedReport(witness, { base: new Date(Date.now() - 86_400_000).toISOString() });
  await witness.$executeRaw`UPDATE emr_signing.signed_version SET outcome = jsonb_set(outcome, '{signedAt}', ${JSON.stringify(OLD)}::jsonb)
    WHERE record_id = ${recent.uid}`;
  const recentWhole = await stored(witness, recent.uid);
  assert.deepEqual(await new R.ReportRetention(db, new R.ReportLedgerFile(dir)).destroy(recent.unit),
    { unit: recent.unit, outcome: 'unconfirmed', code: 'signature-summary-mismatch', dueDay: null, overdue: null });
  assert.deepEqual(await stored(witness, recent.uid), recentWhole);
  // Review r2 F1: an expired report whose stored structured item or citation is no longer the one its signature signed is
  // not dated by that signature: kept unconfirmed, nothing recorded.
  const before = entries(new R.ReportLedgerFile(dir)).length;
  for (const [column, change] of [['structured', `jsonb_set(structured, '{0,enteredBy}', '"syn-other"')`],
      ['citations', `jsonb_set(citations, '{0,findingRevision}', '2')`]]) {
    const changed = await seedReport(witness);
    await witness.$executeRawUnsafe(`UPDATE "ReportVersion" SET ${column} = ${change} WHERE uid = $1`, changed.uid);
    const changedWhole = await stored(witness, changed.uid);
    assert.deepEqual(await new R.ReportRetention(db, new R.ReportLedgerFile(dir)).destroy(changed.unit),
      { unit: changed.unit, outcome: 'unconfirmed', code: 'signature-version-mismatch', dueDay: null, overdue: null }, column);
    assert.deepEqual(await stored(witness, changed.uid), changedWhole, column);
  }
  assert.equal(entries(new R.ReportLedgerFile(dir)).length, before, 'nothing recorded');
});

test('PG09 D13/E2: an answer lost after the commit is completed by the next run under the same operation ID, with one started record', async () => {
  const { witness, db, dir, ledger } = await database();
  const r = await seedReport(witness);
  const seq = (await anchor(witness)).seq;
  const lossy = losingAnswer(db, async () => (await anchor(witness)).seq > seq);
  const error = await new R.ReportRetention(lossy, ledger()).destroy(r.unit).then(() => null, e => e);
  assert.equal(error?.code, 'DestructionCommitUnknown');
  const operationId = error.operationId;
  assert.deepEqual(R.attemptRecords(ledger(), operationId).map(x => x.phase), ['started']);
  assert.equal((await stored(witness, r.uid)).rs, 'D', 'the deletion did commit');
  // The next run (another process: nothing in memory) settles exactly that attempt from the anchor.
  await new R.ReportRetention(db, ledger()).sweep();
  const records = R.attemptRecords(ledger(), operationId);
  assert.deepEqual(records.map(x => [x.phase, x.unit]), [['started', r.unit], ['completed', r.unit]]);
  assert.equal(entries(ledger()).filter(e => e.record.disposalUnitId === r.unit && e.record.phase === 'started').length, 1);
  assert.deepEqual(SWEEP.reportRetentionAttempt(operationId, dir).settled, true);
});

/** The rows of one report as a backup taken now holds them; the returned function puts them back (a restored older copy). */
async function olderCopy(witness, r) {
  const copy = {
    state: (await witness.$queryRaw`SELECT "repDoc", confirm, "draftEpoch"::text AS epoch FROM "StudyState" WHERE uid = ${r.uid}`)[0],
    head: await witness.$queryRaw`SELECT * FROM "Report" WHERE uid = ${r.uid}`,
    versions: await witness.$queryRaw`SELECT * FROM "ReportVersion" WHERE uid = ${r.uid}`,
    signatures: await witness.$queryRaw`SELECT record_id, version_id, kid, outcome::text AS outcome FROM emr_signing.signed_version WHERE record_id = ${r.uid}`,
    operations: await witness.$queryRaw`SELECT operation_id, fingerprint, outcome::text AS outcome FROM emr_signing.operation WHERE outcome ->> 'recordId' = ${r.uid}`,
    anchor: await witness.$queryRaw`SELECT seq, initialized, "lastCompletedUnit", "lastCompletedAt" FROM "ReportLedgerAnchor" WHERE id = 1`,
  };
  return () => witness.$transaction(async tx => {
    await tx.$executeRaw`UPDATE "StudyState" SET rs = 'A', "reportUnit" = ${r.unit}, "repDoc" = ${copy.state.repDoc}, confirm = ${copy.state.confirm},
      "draftEpoch" = ${copy.state.epoch}::uuid WHERE uid = ${r.uid}`;
    for (const h of copy.head) await tx.$executeRaw`INSERT INTO "Report"(uid, findings, conclusion, recommendation, version, "updatedBy", "updatedAt")
      VALUES (${h.uid}, ${h.findings}, ${h.conclusion}, ${h.recommendation}, ${h.version}, ${h.updatedBy}, ${h.updatedAt})`;
    for (const v of copy.versions) await tx.$executeRaw`INSERT INTO "ReportVersion"(id, uid, version, action, findings, conclusion, recommendation, author, at)
      VALUES (${v.id}, ${v.uid}, ${v.version}, ${v.action}, ${v.findings}, ${v.conclusion}, ${v.recommendation}, ${v.author}, ${v.at})`;
    for (const s of copy.signatures) await tx.$executeRaw`INSERT INTO emr_signing.signed_version(record_id, version_id, kid, outcome)
      VALUES (${s.record_id}, ${s.version_id}, ${s.kid}, ${s.outcome}::jsonb)`;
    for (const o of copy.operations) await tx.$executeRaw`INSERT INTO emr_signing.operation(operation_id, fingerprint, outcome)
      VALUES (${o.operation_id}, ${o.fingerprint}, ${o.outcome}::jsonb)`;
    const a = copy.anchor[0];
    await tx.$executeRaw`UPDATE "ReportLedgerAnchor" SET seq = ${a.seq}, initialized = ${a.initialized}, "lastCompletedUnit" = ${a.lastCompletedUnit},
      "lastCompletedAt" = ${a.lastCompletedAt} WHERE id = 1`;
  });
}
const GONE = { rs: 'D', unit: null, heads: 0, versions: 0, signatures: 0, operations: 0 };
const shape = async (witness, uid) => { const s = await stored(witness, uid); return { rs: s.rs, unit: s.unit, heads: s.heads, versions: s.versions, signatures: s.signatures, operations: s.operations }; };

test('PG10 D14: the gate re-applies a completed destruction to a restored older copy; a lost confirmation keeps the gate closed', async () => {
  const { witness, db, ledger } = await database();
  const r = await seedReport(witness, { versions: [['approve', true], ['addendum', true]] });
  const restore = await olderCopy(witness, r);
  assert.equal((await new R.ReportRetention(db, ledger()).destroy(r.unit)).outcome, 'destroyed');
  await restore();
  assert.equal((await stored(witness, r.uid)).versions, 2, 'the restored copy holds the destroyed report again');
  const opened = await new R.ReportRetention(db, ledger()).openGate();
  assert.ok(opened.reapplied >= 1);
  assert.deepEqual(await shape(witness, r.uid), GONE);
  // The same copy again; this time the read confirming the re-application gets no answer: the server stays closed.
  await restore();
  const lossy = losingAnswer(db, async () => (await witness.$queryRaw`SELECT count(*)::int AS n FROM "StudyState" WHERE "reportUnit" = ${r.unit}`)[0].n === 0);
  await assert.rejects(new RetentionGate([R.reportRetentionAdapter(() => new R.ReportRetention(lossy, ledger()))]).open(quiet),
    { name: 'RetentionGateClosed', adapter: 'report-retention', code: 'ReportReapplyUnconfirmed' });
  assert.deepEqual(await shape(witness, r.uid), GONE, 'the re-application itself committed');
  await new RetentionGate([R.reportRetentionAdapter(() => new R.ReportRetention(db, ledger()))]).open(quiet);
});

// The ledger mirror (KIN_LEDGER_MIRROR_DIR, 2026-11-06 decision "장부를 따로 한 벌 더 보관"): REQ - a lost report ledger no
// longer leaves the server closed with no way back; RISK - a copy behind the ledger or of another database taking its
// place brings back destructions it completed (RC4, D14/D15); TEST - this case (the file rules: ledger_file_test.cjs).
test('PG11 mirror: every record reaches the mirror; a lost ledger file is restored from it only past the whole gate; a mirror the gate cannot match stays out', async () => {
  const { witness, db, dir } = await database();
  const mirrorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-mirror-'));
  const file = path.join(dir, R.REPORT_LEDGER_FILE), mirror = path.join(mirrorDir, R.REPORT_LEDGER_FILE);
  const mirrored = () => new R.ReportLedgerFile(dir, undefined, mirrorDir);
  const lines = [];
  const gate = (client = db) => new RetentionGate([R.reportRetentionAdapter(() => new R.ReportRetention(client, mirrored()))])
    .open({ log: line => lines.push(line), error() {} });
  const bytes = target => (fs.existsSync(target) ? fs.readFileSync(target) : null);
  // Switched on beside the bound ledger: the gate copies it whole.
  await gate();
  assert.deepEqual(bytes(mirror), bytes(file));
  // A destruction writes its started and completed records to both.
  const r = await seedReport(witness);
  const restore = await olderCopy(witness, r);
  assert.equal((await new R.ReportRetention(db, mirrored()).destroy(r.unit)).outcome, 'destroyed');
  assert.deepEqual(bytes(mirror), bytes(file));
  const ledgerBytes = bytes(file);
  // A mirror the gate cannot match: closed with the file's own answer, the file not created, the mirror unchanged.
  const stays = async (label, code, client = db) => {
    const before = bytes(mirror);
    await assert.rejects(gate(client), e => e.name === 'RetentionGateClosed' && e.code === code, label);
    assert.equal(bytes(file), null, label + ': the file is not created');
    assert.deepEqual(bytes(mirror), before, label + ': the mirror is unchanged');
  };
  await restore();
  fs.unlinkSync(file);
  const original = await anchor(witness);
  await witness.$executeRaw`UPDATE "ReportLedgerAnchor" SET "ledgerId" = gen_random_uuid() WHERE id = 1`;
  try { await stays('another database\'s anchor (D15)', 'ReportLedgerMismatch'); }
  finally { await witness.$executeRaw`UPDATE "ReportLedgerAnchor" SET "ledgerId" = ${original.ledgerId}::uuid WHERE id = 1`; }
  fs.writeFileSync(mirror, ledgerBytes.toString('utf8').split('\n')[0] + '\n');
  await stays('a mirror shorter than the anchor', 'ReportLedgerBehind');
  fs.writeFileSync(mirror, Buffer.concat([ledgerBytes, Buffer.from('{"kind":"entry"')]));
  await stays('an unreadable mirror', 'ReportLedgerMissing');
  fs.writeFileSync(mirror, ledgerBytes);
  const lossy = losingAnswer(db, async () => (await witness.$queryRaw`SELECT count(*)::int AS n FROM "StudyState" WHERE "reportUnit" = ${r.unit}`)[0].n === 0);
  await stays('a re-application not confirmed (D14)', 'ReportReapplyUnconfirmed', lossy);
  assert.deepEqual(await shape(witness, r.uid), GONE, 'that re-application had committed');
  // Passes: the older copy again beside the lost file; re-applied, confirmed, then the file is the ledger again.
  await restore();
  assert.equal((await stored(witness, r.uid)).versions, 1);
  lines.length = 0;
  await gate();
  assert.deepEqual(await shape(witness, r.uid), GONE);
  // Restored byte for byte (the server's after-open sweep may only have appended to both since).
  assert.deepEqual(bytes(file).subarray(0, ledgerBytes.length), ledgerBytes, 'restored byte for byte');
  assert.deepEqual(bytes(mirror), bytes(file));
  assert.ok(lines.some(line => line.includes('report-retention') && line.includes('restored from the mirror (ReportLedgerMissing)')), lines.join('\n'));
  assert.ok(fs.readdirSync(dir).some(name => name.startsWith(R.REPORT_LEDGER_FILE + '.restored-')));
  // A mirror that is not the ledger beside a readable file closes; brought back to the file's bytes, the gate opens.
  const opened = bytes(file);
  fs.appendFileSync(mirror, ledgerBytes.toString('utf8').split('\n')[1] + '\n');
  await assert.rejects(gate(), { name: 'RetentionGateClosed', code: 'ReportLedgerMirrorDiverged' });
  assert.deepEqual(bytes(file), opened);
  fs.writeFileSync(mirror, opened);
  await gate();
});