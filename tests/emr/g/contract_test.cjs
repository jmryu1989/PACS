/* REQ-EMR-03·05·12·18 -> RISK-G-01..05 -> TEST-G-01..05 (EMR-G round 1: pure contract; importer, storage, C/D screens are R2).
 * Assertions bind to the migration contract's behaviour: refusal codes, the facts that are written and read back, the events
 * that do (not) exist and the absence of side effects. Original text, author strings and stored times are compared byte for
 * byte because keeping those bytes is itself the requirement (AGENTS 1-B.14). The legacy source inventory is read with
 * Prisma's installed parser through its generator protocol, never a handwritten schema parser. Synthetic data only.
 * KIN_EMR_G_CONTRACT_SOURCE lets tests/emr/g/mutants.py compile a mutated copy under the real module path; the M-G-*
 * prefixes below name the assertion each required mutant must break.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Prisma invokes this file as a generator to hand over freshly parsed DMMF, without generating a client.
if (process.argv.includes('--emr-g-inventory-generator')) {
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line);
    let result;
    if (request.method === 'getManifest') result = { manifest: { prettyName: 'EMR-G legacy inventory', defaultOutput: './inventory.json' } };
    else if (request.method === 'generate') {
      fs.writeFileSync(request.params.generator.output.value, JSON.stringify(request.params.dmmf.datamodel));
      result = null;
    } else throw new Error(`Unexpected generator request: ${request.method}`);
    process.stderr.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
  });
} else {
  const assert = require('node:assert/strict');
  const declaredCases = [];
  const listing = process.argv.includes('--list-cases');
  const test = (name, body) => {
    assert(!declaredCases.includes(name), `duplicate case: ${name}`);
    declaredCases.push(name);
    if (!listing) require('node:test').test(name, body);
  };
  const { spawnSync } = require('node:child_process');
  const crypto = require('node:crypto');
  const root = path.resolve(__dirname, '..', '..', '..');
  const api = path.join(root, 'api');
  const ts = require(path.join(api, 'node_modules/typescript'));
  const config = ts.readConfigFile(path.join(api, 'tsconfig.json'), ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, api);
  const contractFile = path.join(api, 'src/emr-legacy/contract.ts');
  const override = process.env.KIN_EMR_G_CONTRACT_SOURCE || null;
  const originalTsLoader = require.extensions['.ts'];
  // Same module semantics as api/tsconfig; a mutant copy is compiled under the real file name so its imports resolve alike.
  require.extensions['.ts'] = (module, filename) => {
    const source = fs.readFileSync(override && path.relative(contractFile, filename) === '' ? override : filename, 'utf8');
    module._compile(ts.transpileModule(source, { compilerOptions: parsed.options, fileName: filename }).outputText, filename);
  };
  const G = require(contractFile);
  const M = require(path.join(api, 'src/emr-contract/composition.ts'));
  const C = require(path.join(api, 'src/emr-contract/classification.ts'));
  const D = require(path.join(api, 'src/emr-contract/lawful-defaults.ts'));
  if (originalTsLoader) require.extensions['.ts'] = originalTsLoader; else delete require.extensions['.ts'];

  const sha = value => crypto.createHash('sha256').update(value).digest('hex');
  const CAPTURED = '2026-10-09T03:00:00.000Z', RUN_AT = '2026-10-09T04:00:00.000Z';
  const later = (at, ms) => new Date(Date.parse(at) + ms).toISOString();
  let clock = 0;
  const tick = () => later(RUN_AT, ++clock * 1000);
  const known = value => ({ status: 'known', value });
  const PATIENT_A = { linkId: 'link-a', patientId: 'SYN-A', assigningAuthority: 'hospital-a' };
  const PATIENT_B = { linkId: 'link-b', patientId: 'SYN-B', assigningAuthority: 'hospital-a' };
  const UID1 = '1.2.840.99.1', UID2 = '1.2.840.99.2';
  // Bytes a careless copy would change: double space, CRLF, decomposed Hangul and accent, a surrogate pair.
  const TRICKY = 'Nodule 6 mm  \r\n가 café 😀';
  const SR_SHA = sha('synthetic-sr-bytes');

  function refusal(fn) {
    try { fn(); return null; } catch (error) { if (error && error.name === 'ContractError') return error.code; throw error; }
  }
  const row = (model, columns, extra = {}) => ({ model, columns, timeBasis: 'utc-verified', institution: known('hospital-a'),
    patient: known(PATIENT_A), objects: [], ...extra });
  const version = (id, uid, n, action, findings, author, at, extra) => row('ReportVersion', { id: String(id), uid, version: String(n), action,
    findings, conclusion: '', recommendation: '', reason: null, citations: null, structured: null, author, at }, extra);
  const head = (uid, n, findings, updatedBy, updatedAt, extra) => row('Report', { uid, version: String(n), findings, conclusion: '',
    recommendation: '', updatedBy, updatedAt }, extra);
  const draft = (uid, author, findings, present, extra) => row('ReportDraft', { uid, author, findings, conclusion: '', recommendation: '',
    citations: null, structured: null, revision: '3', present, baseVersion: '2', updatedAt: '2026-03-05T00:00:00.000Z' }, extra);
  const consult = (id, extra) => row('StudyConsultation', { id, revision: '2', state: 'answered', updatedAt: '2026-04-01T02:00:00.000Z',
    requesterActor: 'dr.kim', recipientActor: 'dr.han', recipientName: '한 선생', changedBy: 'dr.han', reason: '비교 의견 요청',
    reply: '이전 CT와 동일', cancelReason: null, studyUid: UID1, institutionId: 'hospital-a', requesterSub: 'sub-kim', recipientSub: 'sub-han',
    creationFingerprint: 'fp-1', lastRequest: '00000000-0000-4000-8000-000000000001', lastFingerprint: 'fp-2', createdAt: '2026-04-01T01:00:00.000Z' }, extra);
  const sr = (id, columns = {}, objects = null) => row('ManualSr', { id, createdAt: '2026-03-03T00:00:00.000Z', authorActor: 'dr.kim',
    selection: '{"items":[1]}', dataset: null, studyUid: UID1, authorSub: 'sub-kim', requestId: '00000000-0000-4000-8000-000000000002',
    fingerprint: 'fp-sr', sha256: SR_SHA, storedAt: '2026-03-03T00:00:05.000Z', orthancId: 'orthanc-sr-1', attemptedAt: null, nextCheckAt: null, ...columns },
  { objects: objects ?? [{ objectKey: 'database-bytes', present: true, sha256: SR_SHA }, { objectKey: 'orthanc-instance', present: true, sha256: SR_SHA }] });
  function baseRows() {
    return [
      version(1, UID1, 1, 'save', 'first wording', 'dr.kim', '2026-03-02T01:00:00.000Z'),
      version(2, UID1, 2, 'approve', TRICKY, 'dr.kim', '2026-03-02T02:00:00.000Z'),
      head(UID1, 2, TRICKY, 'dr.kim', '2026-03-02T02:00:00.000Z'),
      draft(UID1, 'dr.lee', 'my own notes', 'true'),
      version(3, UID2, 1, 'approve', 'B finding', 'dr.park', '2026-03-04T00:00:00.000Z', { patient: known(PATIENT_B) }),
      head(UID2, 1, 'B finding', 'dr.park', '2026-03-04T00:00:00.000Z', { patient: known(PATIENT_B) }),
      consult('00000000-0000-4000-8000-0000000000c1'),
      sr('00000000-0000-4000-8000-0000000000d1'),
    ];
  }
  const ALL_MODELS = ['Report', 'ReportVersion', 'ReportDraft', 'StudyConsultation', 'ManualSr'];
  const snapshot = (rows = baseRows(), extra = {}) => G.sealLegacySnapshot({ format: 'emr-legacy/1', snapshotId: 'snap-1',
    source: { databaseId: 'legacy-db-1', capturedAt: CAPTURED },
    scope: { institutionId: 'hospital-a', models: ALL_MODELS, rowCount: rows.length }, rows, ...extra });
  const planOf = (sealed = snapshot()) => G.planLegacyMigration(G.parseLegacySnapshot(sealed));
  const sourceKeyOf = r => JSON.stringify(G.LEGACY_SOURCES[r.model].key.map(c => r.columns[c]));

  // Synthetic store: one transaction makes a unit's bodies and its checkpoint durable together.
  const newStore = () => ({ items: new Map(), checkpoints: [], records: new Map(), writes: 0 });
  const recordIdOf = recordClass => 'rec:' + sha(recordClass).slice(0, 16);
  const versionIdOf = itemKey => 'ver:' + itemKey.slice(7, 23);
  const storedOf = store => ({ complete: true, items: [...store.items.values()].map(x => ({ ...x })), checkpoints: store.checkpoints.map(c => ({ ...c })) });
  const readBackOf = store => ({ complete: true, records: [...store.records.values()].map(r => structuredClone(r)) });
  function commit(store, unit) {
    for (const w of unit.writes) {
      store.items.set(w.itemKey, { itemKey: w.itemKey, rowSha256: w.rowSha256, runId: unit.runId, unitId: unit.unitId });
      store.records.set(w.itemKey, { ...structuredClone(w), target: { recordId: recordIdOf(w.recordClass), versionId: versionIdOf(w.itemKey), sha256: w.contentSha256 },
        targetPredecessor: w.predecessorItemKey === null ? null : { recordId: recordIdOf(w.recordClass), versionId: versionIdOf(w.predecessorItemKey) } });
      store.writes++;
    }
    store.checkpoints.push({ runId: unit.checkpoint.runId, unitId: unit.checkpoint.unitId, through: unit.checkpoint.through });
  }
  function assertCheckpointBehindBodies(store, plan, runId, label) {
    const through = Math.max(0, ...store.checkpoints.filter(c => c.runId === runId).map(c => c.through));
    const missing = plan.items.slice(0, through).filter(i => !store.items.has(i.itemKey)).map(i => i.itemKey);
    assert.deepEqual(missing, [], `M-G-05: a committed checkpoint never runs ahead of its stored bodies (${label})`);
  }
  function startRun(plan, store, runId = 'run-1', at = RUN_AT) {
    const receipt = G.dryRunLegacyMigration(plan, storedOf(store), at);
    return G.startLegacyRun(plan, receipt, storedOf(store), { runId, at, actorId: 'svc-emr-legacy-migrator' });
  }
  function drive(journal, plan, store, { size = 2, units = Infinity, onUnit = null } = {}) {
    for (let n = 0; n < units; n++) {
      const step = G.nextLegacyUnit(journal, plan, { at: tick(), size });
      journal = step.journal;
      if (!step.unit) break;
      if (onUnit) onUnit(step.unit);
      commit(store, step.unit);
      assertCheckpointBehindBodies(store, plan, journal.runId, `size ${size}, from ${step.unit.from}`);
      journal = G.recordLegacyCommit(journal, plan, step.unit, 'committed', tick());
    }
    return journal;
  }
  function migrated(rows = baseRows()) {
    const sealed = snapshot(rows), plan = planOf(sealed), store = newStore(), units = [];
    const journal = drive(startRun(plan, store), plan, store, { onUnit: unit => units.push(unit) });
    return { sealed, plan, store, units, journal, result: G.reconcileLegacyMigration(plan, readBackOf(store)) };
  }
  const writesOf = units => units.flatMap(u => u.writes.map(w => ({ unit: u, write: w })));
  const findRecord = (records, model, uid, sequence) => records.find(r => r.model === model && r.original.columns.uid === uid && r.sequence === sequence);
  const signer = (display = 'dr.choi', over = {}) => ({ identity: { id: 'member-7', issuer: 'https://identity.example.test', subject: 'sub-7' },
    display, kind: 'member', roles: ['radiologist'], canSign: true, canReadStudy: true, ...over });
  const viewedOf = record => ({ rowSha256: record.marking.provenance.rowSha256, contentSha256: record.contentSha256, snapshotId: record.marking.provenance.snapshotId });

  function modelInventory() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emr-g-inventory-'));
    try {
      const output = path.join(dir, 'inventory.json');
      const provider = `"${process.execPath.replaceAll('\\', '/')}" "${__filename.replaceAll('\\', '/')}" --emr-g-inventory-generator`;
      const schema = `generator emr_g_inventory {\n provider = ${JSON.stringify(provider)}\n output = ${JSON.stringify(output.replaceAll('\\', '/'))}\n}\n` +
        fs.readFileSync(path.join(api, 'prisma/schema.prisma'), 'utf8');
      fs.writeFileSync(path.join(dir, 'schema.prisma'), schema);
      const result = spawnSync(process.execPath, [path.join(api, 'node_modules/prisma/build/index.js'), 'generate', '--schema', path.join(dir, 'schema.prisma'),
        '--generator', 'emr_g_inventory'], { cwd: dir, encoding: 'utf8', timeout: 60000, env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: '1',
        CHECKPOINT_DISABLE: '1', DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:1/never_connect' } });
      assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
      return JSON.parse(fs.readFileSync(output, 'utf8')).models;
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

  test('TEST-G-01 reconcile allow: every row keeps its original text, author string, time, patient, version and object hash', () => {
    const { sealed, plan, store, result } = migrated();
    const source = structuredClone(sealed);
    assert.equal(result.status, 'matched-with-unresolved');
    assert.deepEqual(result.rows.map(r => [r.result, r.mismatches]), plan.items.map(() => ['matched', []]));
    assert.deepEqual(result.counts, { rows: 8, planned: 8, excluded: 0, readBack: 8, matched: 8 });
    assert.deepEqual(result.unresolved.map(f => [f.model, f.fact]), [['ReportDraft', 'purpose-end']]);
    for (const input of sealed.rows) {
      const stored = [...store.records.values()].filter(r => r.model === input.model && r.sourceKey === sourceKeyOf(input));
      assert.equal(stored.length, 1);
      assert.deepEqual(stored[0].original.columns, input.columns);
      assert.deepEqual(stored[0].original.time, { value: input.columns[G.LEGACY_SOURCES[input.model].time], basis: input.timeBasis },
        'M-G-01S: the stored original time is never replaced by the migration time');
      assert.deepEqual([stored[0].patient, stored[0].institution, stored[0].objects], [input.patient, input.institution, input.objects]);
    }
    assert.equal(findRecord(result.records, 'ReportVersion', UID1, 2).original.columns.findings, TRICKY);
    assert.deepEqual(sealed, source, 'the source snapshot is never changed');
    // Without an open fact the same run is a plain match.
    const plain = migrated(baseRows().filter(r => r.model !== 'ReportDraft')).result;
    assert.equal(plain.status, 'matched');
  });

  test('TEST-G-01 reconcile allow: original stored time survives migration', () => {
    const { sealed, units } = migrated();
    for (const { write } of writesOf(units)) {
      const source = sealed.rows.find(r => r.model === write.model && sourceKeyOf(r) === write.sourceKey);
      assert.deepEqual(write.original.time, { value: source.columns[G.LEGACY_SOURCES[source.model].time], basis: source.timeBasis },
        'M-G-01S: the stored original time is never replaced by the migration time');
    }
  });

  test('TEST-G-01 reconcile refuse: equal totals with two patients exchanged fail on both rows', () => {
    const { plan, store } = migrated();
    const back = readBackOf(store);
    const a = findRecord(back.records, 'ReportVersion', UID1, 2), b = findRecord(back.records, 'ReportVersion', UID2, 1);
    [a.patient, b.patient] = [b.patient, a.patient];
    const before = structuredClone(back);
    const result = G.reconcileLegacyMigration(plan, back);
    assert.deepEqual(back, before, 'the read-back is not modified');
    assert.equal(result.counts.readBack, result.counts.planned, 'the totals agree');
    const moved = result.rows.filter(r => r.mismatches.includes('patient')).map(r => r.itemKey).sort();
    assert.deepEqual(moved, [a.itemKey, b.itemKey].sort(), 'M-G-04: equal totals with exchanged patients must fail on each exchanged row');
    assert.equal(result.status, 'failed');
  });

  test('TEST-G-01 reconcile refuse: moved text, normalized bytes, missing, duplicate, extra, re-chained and merged records fail', () => {
    const { plan, store } = migrated();
    const cases = {
      'exchanged text': back => {
        const v1 = findRecord(back.records, 'ReportVersion', UID1, 1), v2 = findRecord(back.records, 'ReportVersion', UID1, 2);
        [v1.original.columns.findings, v2.original.columns.findings] = [v2.original.columns.findings, v1.original.columns.findings];
        return [[v1.itemKey, 'columns'], [v2.itemKey, 'columns']];
      },
      'normalized bytes': back => {
        const v2 = findRecord(back.records, 'ReportVersion', UID1, 2);
        v2.original.columns.findings = v2.original.columns.findings.normalize('NFC').replace('\r\n', '\n');
        return [[v2.itemKey, 'columns']];
      },
      'missing row': back => { const [gone] = back.records.splice(3, 1); return [[gone.itemKey, 'missing']]; },
      'duplicate row': back => { back.records.push(structuredClone(back.records[0])); return [[back.records[0].itemKey, 'duplicate']]; },
      'extra row': back => {
        const extra = structuredClone(back.records[0]); extra.itemKey = 'legacy:' + 'f'.repeat(64); back.records.push(extra);
        return [[extra.itemKey, 'unexpected']];
      },
      're-chained versions': back => {
        const v1 = findRecord(back.records, 'ReportVersion', UID1, 1), v2 = findRecord(back.records, 'ReportVersion', UID1, 2);
        [v1.target.versionId, v2.target.versionId] = [v2.target.versionId, v1.target.versionId];
        return [[v2.itemKey, 'version-chain']];
      },
      'draft merged into the report': back => {
        const d = back.records.find(r => r.model === 'ReportDraft');
        d.target.recordId = findRecord(back.records, 'ReportVersion', UID1, 1).target.recordId;
        return [[d.itemKey, 'record-mapping']];
      },
    };
    for (const [name, change] of Object.entries(cases)) {
      const back = readBackOf(store), expected = change(back);
      const result = G.reconcileLegacyMigration(plan, back);
      assert.equal(result.status, 'failed', name);
      for (const [itemKey, mismatch] of expected) {
        assert(result.rows.some(r => r.itemKey === itemKey && r.mismatches.includes(mismatch)), `${name}: ${mismatch}`);
      }
    }
    assert.equal(refusal(() => G.reconcileLegacyMigration(plan, { ...readBackOf(store), complete: false })), 'ReadBackIncomplete');
    assert.equal(refusal(() => G.reconcileLegacyMigration({ ...plan }, readBackOf(store))), 'MigrationPlanRequired');
  });

  test('TEST-G-01 reconcile: the sealed snapshot binds every row, the scope and the count', () => {
    const sealed = snapshot();
    const reordered = { ...structuredClone(sealed), rows: [...sealed.rows].reverse().map(r => ({ objects: r.objects, patient: r.patient,
      institution: r.institution, timeBasis: r.timeBasis, columns: Object.fromEntries(Object.entries(r.columns).reverse()), model: r.model })) };
    assert.equal(G.parseLegacySnapshot(reordered).inputSha256, sealed.inputSha256, 'key and row order of the exporter do not change the seal');
    const tampered = structuredClone(sealed); tampered.rows[1].columns.findings += ' ';
    assert.equal(refusal(() => G.parseLegacySnapshot(tampered)), 'LegacySnapshotHashMismatch');
    const recounted = structuredClone(sealed); recounted.scope.rowCount = 7;
    assert.equal(refusal(() => G.parseLegacySnapshot(recounted)), 'LegacyCountMismatch');
    const foreign = baseRows(); foreign[6].institution = known('hospital-b');
    assert.equal(refusal(() => snapshot(foreign)), 'LegacyScopeMismatch');
    assert.equal(refusal(() => snapshot(baseRows().filter(r => r.model !== 'ReportVersion'), {
      scope: { institutionId: 'hospital-a', models: ['Report', 'ReportDraft', 'StudyConsultation', 'ManualSr'], rowCount: 5 } })), 'LegacyScopeIncomplete');
    assert.equal(refusal(() => snapshot(baseRows(), { scope: { institutionId: 'hospital-a', models: ['Report', 'ReportVersion', 'ReportDraft', 'StudyConsultation'], rowCount: 8 } })), 'LegacyScopeMismatch');
    const doubled = baseRows(); doubled.push(structuredClone(doubled[0]));
    assert.equal(refusal(() => snapshot(doubled)), 'LegacyRowDuplicate');
    const local = baseRows(); local[0].columns.at = '2026-03-02 10:00:00';
    assert.equal(refusal(() => snapshot(local)), 'LegacyTimeMalformed', 'a time declared verified must be exact UTC');
    const short = baseRows(); delete short[0].columns.reason;
    assert.equal(refusal(() => snapshot(short)), 'LegacySnapshotMalformed');
    const lone = baseRows(); lone[1].columns.findings = 'broken \uD800';
    assert.equal(refusal(() => snapshot(lone)), 'LegacySnapshotMalformed');
    assert.equal(refusal(() => G.planLegacyMigration({ ...G.parseLegacySnapshot(sealed) })), 'ParsedSnapshotRequired');
  });

  test('TEST-G-01 reconcile: every legacy column the contract reads exists in the frozen Prisma model with its type and key', () => {
    const models = new Map(modelInventory().map(m => [m.name, m]));
    for (const [name, t] of Object.entries(G.LEGACY_SOURCES)) {
      const m = models.get(name);
      assert(m, name);
      const fields = new Map(m.fields.filter(f => f.kind === 'scalar').map(f => [f.name, f]));
      const pk = m.primaryKey ? m.primaryKey.fields : m.fields.filter(f => f.isId).map(f => f.name);
      assert.deepEqual([...t.key], pk, `${name} re-run key is the primary key`);
      const typed = { [t.time]: ['DateTime'] };
      if (t.sequence) typed[t.sequence] = ['Int'];
      if (t.presence) typed[t.presence] = ['Boolean'];
      for (const c of t.text) typed[c] = ['String', 'Json'];
      for (const c of t.authors) typed[c] = ['String'];
      for (const o of t.objects) {
        typed[o.hashColumn] = ['String'];
        if (o.bytesColumn) typed[o.bytesColumn] = ['Bytes'];
        if (o.locatorColumn) typed[o.locatorColumn] = ['String'];
      }
      for (const c of [...t.key, ...t.record, ...(t.action ? [t.action] : []), ...t.preserve, ...Object.keys(typed)]) assert(fields.has(c), `${name}.${c}`);
      for (const [c, types] of Object.entries(typed)) assert(types.includes(fields.get(c).type), `${name}.${c} is ${types.join('|')}`);
    }
  });

  test('TEST-G-02 restart allow: a crash at any unit boundary resumes to exactly one stored copy of every row', () => {
    const plan = planOf(), total = plan.items.length;
    for (const size of [1, 3]) for (let crashAfter = 0; crashAfter <= Math.ceil(total / size); crashAfter++) for (const lost of ['before-commit', 'after-commit']) {
      const store = newStore();
      const journal = drive(startRun(plan, store), plan, store, { size, units: crashAfter });
      const inFlight = G.nextLegacyUnit(journal, plan, { at: tick(), size });
      if (inFlight.unit) {
        if (lost === 'after-commit') {
          commit(store, inFlight.unit);
          assertCheckpointBehindBodies(store, plan, journal.runId, `crash after commit, size ${size}`);
        }
        drive(G.resumeLegacyRun(inFlight.journal, plan, storedOf(store), tick()), plan, store, { size });
      }
      const label = `size ${size}, crash after ${crashAfter} units, ${lost}`;
      assert.equal(store.writes, total, `each row is written exactly once (${label})`);
      assert.deepEqual([...store.items.values()].map(i => i.rowSha256).sort(), plan.items.map(i => i.rowSha256).sort(), label);
    }
  });

  test('TEST-G-02 restart allow: stop finishes the unit in flight, starts nothing new and leaves restart data', () => {
    const plan = planOf(), store = newStore();
    const step = G.nextLegacyUnit(startRun(plan, store), plan, { at: tick(), size: 3 });
    let journal = G.requestLegacyStop(step.journal, plan, tick());
    assert.equal(journal.state, 'stopping');
    commit(store, step.unit);
    journal = G.recordLegacyCommit(journal, plan, step.unit, 'committed', tick());
    const after = G.nextLegacyUnit(journal, plan, { at: tick(), size: 3 });
    assert.equal(after.unit, null);
    assert.equal(after.journal.state, 'stopped');
    assert.deepEqual([after.journal.checkpoint.through, store.writes], [3, 3]);
    assert.equal(refusal(() => G.nextLegacyUnit(after.journal, plan, { at: tick(), size: 3 })), 'RunNotActive');
    assert.equal(store.writes, 3, 'a stopped run writes nothing');
    const done = drive(G.resumeLegacyRun(after.journal, plan, storedOf(store), tick()), plan, store, { size: 3 });
    assert.equal(done.state, 'completed');
    assert.equal(store.writes, plan.items.length);
    assert.deepEqual(done.history.map(h => h.kind), ['run-started', 'stop-requested', 'run-stopped', 'run-resumed', 'run-completed']);
  });

  test('TEST-G-02 restart allow: re-running the same source after completion writes nothing', () => {
    const { store } = migrated(), writes = store.writes;
    const again = planOf(snapshot());
    const receipt = G.dryRunLegacyMigration(again, storedOf(store), tick());
    assert.deepEqual([receipt.preexisting.length, receipt.conflicts.length, receipt.ok], [again.items.length, 0, true]);
    const journal = drive(G.startLegacyRun(again, receipt, storedOf(store), { runId: 'run-2', at: tick(), actorId: 'svc-emr-legacy-migrator' }), again, store);
    assert.equal(journal.state, 'completed');
    assert.equal(store.writes, writes, 'no duplicate of an already migrated row');
    assert.notEqual(G.reconcileLegacyMigration(again, readBackOf(store)).status, 'failed', 'restart also preserves original provenance');
  });

  test('TEST-G-02 restart refuse: a changed source under the same snapshot and different bytes for a migrated row are refused', () => {
    const plan = planOf(), store = newStore();
    const journal = drive(startRun(plan, store), plan, store, { units: 1 });
    const rows = baseRows(); rows[4].columns.findings = 'B finding, edited after capture';
    const changed = planOf(snapshot(rows));
    const before = storedOf(store), writes = store.writes;
    assert.equal(refusal(() => G.resumeLegacyRun(journal, changed, storedOf(store), tick())), 'SourceSnapshotChanged');
    assert.equal(refusal(() => G.nextLegacyUnit(journal, changed, { at: tick(), size: 2 })), 'SourceSnapshotChanged');
    assert.deepEqual([storedOf(store), store.writes], [before, writes]);

    const done = migrated(), original = structuredClone([...done.store.records.values()]);
    const edited = baseRows(); edited[1].columns.findings = 'approved wording, edited after migration';
    const conflicting = planOf(snapshot(edited, { snapshotId: 'snap-3' }));
    const receipt = G.dryRunLegacyMigration(conflicting, storedOf(done.store), tick());
    const changedKey = conflicting.items.find(i => i.model === 'ReportVersion' && i.columns.id === '2').itemKey;
    assert.deepEqual([receipt.ok, receipt.conflicts.map(c => c.itemKey)], [false, [changedKey]]);
    assert.equal(refusal(() => G.startLegacyRun(conflicting, receipt, storedOf(done.store), { runId: 'run-3', at: tick(), actorId: 'svc' })), 'LegacyItemConflict');
    assert.deepEqual([...done.store.records.values()], original, 'the migrated original is not overwritten');
  });

  test('TEST-G-02 restart refuse: a checkpoint ahead of its stored bodies, an orphan body and a partial re-read are refused', () => {
    const plan = planOf();
    const ahead = newStore(), aheadJournal = drive(startRun(plan, ahead), plan, ahead, { units: 1 });
    ahead.items.delete(plan.items[1].itemKey);
    assert.equal(refusal(() => G.resumeLegacyRun(aheadJournal, plan, storedOf(ahead), tick())), 'CheckpointAheadOfBody',
      'M-G-05R: a stored checkpoint over a missing body is refused, never resumed past');
    const claims = newStore(), claimsJournal = drive(startRun(plan, claims), plan, claims, { units: 2 });
    claims.checkpoints.pop();
    for (const i of plan.items.slice(2, 4)) claims.items.delete(i.itemKey);
    assert.equal(refusal(() => G.resumeLegacyRun(claimsJournal, plan, storedOf(claims), tick())), 'CheckpointAheadOfBody');
    const orphan = newStore(), orphanJournal = drive(startRun(plan, orphan), plan, orphan, { units: 1 });
    orphan.items.set(plan.items[3].itemKey, { itemKey: plan.items[3].itemKey, rowSha256: plan.items[3].rowSha256, runId: 'run-1', unitId: 'unit:orphan' });
    assert.equal(refusal(() => G.resumeLegacyRun(orphanJournal, plan, storedOf(orphan), tick())), 'JournalStoreDiverged');
    const racing = newStore(), racingJournal = drive(startRun(plan, racing), plan, racing, { units: 1 });
    racing.items.set(plan.items[4].itemKey, { itemKey: plan.items[4].itemKey, rowSha256: plan.items[4].rowSha256, runId: 'run-other', unitId: 'unit:other' });
    assert.equal(refusal(() => G.resumeLegacyRun(racingJournal, plan, storedOf(racing), tick())), 'JournalStoreDiverged', 'a row another writer migrated meanwhile is not written twice');
    assert.equal(refusal(() => G.resumeLegacyRun(orphanJournal, plan, { ...storedOf(orphan), complete: false }, tick())), 'StoredFactsIncomplete');
    const twice = storedOf(orphan); twice.items.push({ ...twice.items[0] });
    assert.equal(refusal(() => G.resumeLegacyRun(orphanJournal, plan, twice, tick())), 'JournalStoreDiverged');
  });

  test('TEST-G-02 restart: an unknown commit outcome is resolved only by re-reading the unit, and apply needs a current clean dry-run', () => {
    const plan = planOf();
    const lost = newStore(), step = G.nextLegacyUnit(startRun(plan, lost), plan, { at: tick(), size: 2 });
    assert.equal(refusal(() => G.nextLegacyUnit(step.journal, plan, { at: tick(), size: 2 })), 'UnitPending');
    commit(lost, step.unit);
    let journal = G.recordLegacyCommit(step.journal, plan, step.unit, 'unknown', tick());
    assert.equal(journal.state, 'commit-unknown');
    assert.equal(refusal(() => G.nextLegacyUnit(journal, plan, { at: tick(), size: 2 })), 'CommitOutcomeUnknown');
    assert.equal(refusal(() => G.recordLegacyCommit(journal, plan, step.unit, 'committed', tick())), 'CommitOutcomeUnknown');
    journal = G.resolveLegacyCommit(journal, plan, storedOf(lost), tick());
    assert.deepEqual([journal.state, journal.checkpoint.through], ['applying', 2]);

    const never = newStore(), first = G.nextLegacyUnit(startRun(plan, never), plan, { at: tick(), size: 2 });
    const unresolved = G.recordLegacyCommit(first.journal, plan, first.unit, 'unknown', tick());
    const resolved = G.resolveLegacyCommit(unresolved, plan, storedOf(never), tick());
    assert.equal(resolved.checkpoint.through, 0);
    assert.equal(G.nextLegacyUnit(resolved, plan, { at: tick(), size: 2 }).unit.unitId, first.unit.unitId, 'the same unit is retried under its own ID');

    const partial = newStore(), half = G.nextLegacyUnit(startRun(plan, partial), plan, { at: tick(), size: 2 });
    const w = half.unit.writes[0];
    partial.items.set(w.itemKey, { itemKey: w.itemKey, rowSha256: w.rowSha256, runId: 'run-1', unitId: half.unit.unitId });
    const halfJournal = G.recordLegacyCommit(half.journal, plan, half.unit, 'unknown', tick());
    assert.equal(refusal(() => G.resolveLegacyCommit(halfJournal, plan, storedOf(partial), tick())), 'JournalStoreDiverged');

    const store = newStore(), other = planOf(snapshot(baseRows().slice(0, 7)));
    assert.equal(refusal(() => G.startLegacyRun(plan, G.dryRunLegacyMigration(other, storedOf(store), tick()), storedOf(store),
      { runId: 'run-1', at: tick(), actorId: 'svc' })), 'DryRunMismatch');
    const receipt = G.dryRunLegacyMigration(plan, storedOf(store), tick());
    store.items.set(plan.items[0].itemKey, { itemKey: plan.items[0].itemKey, rowSha256: plan.items[0].rowSha256, runId: 'run-0', unitId: 'unit:x' });
    assert.equal(refusal(() => G.startLegacyRun(plan, receipt, storedOf(store), { runId: 'run-1', at: tick(), actorId: 'svc' })), 'DryRunStale');
    assert.equal(refusal(() => G.startLegacyRun(plan, G.dryRunLegacyMigration(plan, storedOf(store), tick()), storedOf(store),
      { runId: 'run-0', at: tick(), actorId: 'svc' })), 'RunIdReused');
  });

  test('TEST-G-02 restart refuse: foreign unit receipts and changed commit bodies cannot advance the checkpoint', () => {
    const plan = planOf(), store = newStore();
    const step = G.nextLegacyUnit(startRun(plan, store), plan, { at: tick(), size: 2 });
    const original = structuredClone(step);
    const unitChanges = [
      u => { u.writes.pop(); },
      u => { u.writes[0].original.columns.findings = 'different bytes'; },
      u => { u.checkpoint.runId = 'another-run'; },
      u => { u.checkpoint.unitId = 'another-unit'; },
      u => { u.runId = 'another-run'; },
      u => { u.from = 1; },
    ];
    for (const change of unitChanges) {
      const unit = structuredClone(step.unit); change(unit);
      assert.equal(refusal(() => G.recordLegacyCommit(step.journal, plan, unit, 'committed', tick())), 'UnitMismatch');
    }
    assert.deepEqual(step, original, 'a refused receipt leaves journal and proposed originals unchanged');
    assert.equal(store.writes, 0);
    commit(store, step.unit);
    const unknown = G.recordLegacyCommit(step.journal, plan, step.unit, 'unknown', tick());
    const changes = [
      s => { s.checkpoints[0].unitId = 'another-unit'; },
      s => { s.items[0].unitId = 'another-unit'; },
      s => { s.items[0].runId = 'another-run'; },
      s => { s.checkpoints.push({ ...s.checkpoints[0] }); },
    ];
    for (const change of changes) {
      const facts = storedOf(store); change(facts);
      const before = structuredClone(facts);
      assert.equal(refusal(() => G.resolveLegacyCommit(unknown, plan, facts, tick())), 'JournalStoreDiverged',
        'matching counts cannot substitute for the pending transaction identity');
      assert.deepEqual(facts, before);
    }
    const resolved = G.resolveLegacyCommit(JSON.parse(JSON.stringify(unknown)), plan, storedOf(store), tick());
    assert.equal(resolved.checkpoint.unitId, step.unit.unitId, 'serialized restart data resolves the exact committed unit');
    assert.equal(unknown.state, 'commit-unknown', 'resolution returns a new journal');
  });

  test('TEST-G-02 restart refuse: malformed journals and vanished acknowledgments preserve storage and the pending outcome', () => {
    const plan = planOf(), store = newStore(), journal = startRun(plan, store);
    const changes = [
      j => { j.pending = { unitId: 'x', from: 0, through: plan.items.length + 1 }; },
      j => { j.checkpoint = { through: plan.items.length + 1, lastItemKey: 'x', unitId: 'x' }; },
      j => { j.preexisting = ['foreign-row']; },
      j => { j.state = 'completed'; },
      j => { j.state = 'commit-unknown'; },
      j => { j.history = [{ kind: 'run-started', at: 'invalid' }]; },
    ];
    for (const change of changes) {
      const altered = structuredClone(journal); change(altered);
      assert.equal(refusal(() => G.nextLegacyUnit(altered, plan, { at: tick(), size: 2 })), 'MigrationJournalMalformed');
    }
    assert.deepEqual(storedOf(store), { complete: true, items: [], checkpoints: [] });
    const prior = migrated(), restarted = startRun(plan, prior.store, 'run-2');
    prior.store.items.delete(plan.items.at(-1).itemKey);
    assert.equal(refusal(() => G.resumeLegacyRun(restarted, plan, storedOf(prior.store), tick())), 'JournalStoreDiverged',
      'a vanished acknowledged row must not be silently skipped later');
    assert.equal(refusal(() => startRun(plan, newStore(), 'old-run', later(CAPTURED, -1))), 'ServerTimeRefused');
  });

  test('TEST-G-02 restart allow: a stop while the commit outcome is unknown resolves before any new unit', () => {
    const plan = planOf();
    for (const committed of [false, true]) {
      const store = newStore(), step = G.nextLegacyUnit(startRun(plan, store), plan, { at: tick(), size: 2 });
      if (committed) commit(store, step.unit);
      const unknown = G.recordLegacyCommit(step.journal, plan, step.unit, 'unknown', tick());
      const stopped = G.requestLegacyStop(unknown, plan, tick());
      assert.equal(stopped.state, 'commit-unknown');
      const resolved = G.resolveLegacyCommit(stopped, plan, storedOf(store), tick());
      const end = G.nextLegacyUnit(resolved, plan, { at: tick(), size: 2 });
      assert.deepEqual([end.journal.state, end.unit, store.writes], ['stopped', null, committed ? 2 : 0]);
      drive(G.resumeLegacyRun(end.journal, plan, storedOf(store), tick()), plan, store);
      assert.equal(store.writes, plan.items.length);
    }
  });

  test('TEST-G-03 unsigned_supplement allow: Legacy Unsigned stays and a current clinician adds a current-time supplement', () => {
    const { plan, store, result } = migrated();
    const target = findRecord(result.records, 'ReportVersion', UID1, 2), at = later(RUN_AT, 86_400_000);
    const supplement = G.planLegacySupplement(result, target.itemKey, { signer: signer(), at, viewed: viewedOf(target) });
    assert.deepEqual([supplement.act, supplement.at, supplement.signer], [G.SUPPLEMENT_ACT, at, signer().identity]);
    assert.deepEqual(supplement.marking, target.marking);
    assert.equal(supplement.marking.status, 'legacy-unsigned');
    assert.deepEqual(supplement.originalAuthor.values, ['dr.kim']);
    assert.deepEqual([supplement.retention, supplement.amendWindow.status], ['no-new-start', 'not-granted']);
    const stored = store.records.get(target.itemKey);
    store.records.set(target.itemKey, { ...stored, supplements: [supplement.summary] });
    const again = G.reconcileLegacyMigration(plan, readBackOf(store));
    assert.notEqual(again.status, 'failed');
    const after = again.records.find(r => r.itemKey === target.itemKey);
    assert.deepEqual([after.original, after.marking, after.retention, after.lifecycle], [stored.original, stored.marking, stored.retention, stored.lifecycle]);
    assert.deepEqual(after.supplements, [supplement.summary]);
  });

  test('TEST-G-03 unsigned_supplement refuse: migration creates no past signature, approval or reading', () => {
    const { plan, store, units } = migrated();
    const created = writesOf(units).flatMap(({ write }) => write.events);
    assert.deepEqual(created.filter(e => e.signature !== null || e.act !== G.MIGRATION_ACT), [],
      'M-G-03: no signature, approval or reading event exists for any legacy row');
    for (const { unit, write } of writesOf(units)) {
      assert.deepEqual(write.events.map(e => e.at), [unit.at], 'M-G-01: the migration event carries the current server time of its own unit');
    }
    assert(created.every(e => e.at >= CAPTURED));
    const forged = {
      'backdated signature': r => r.events.push({ act: 'entry', at: r.original.time.value, runId: 'run-1', unitId: 'u', actorId: 'svc', signature: { signedAt: r.original.time.value } }),
      'reading event': r => r.events.push({ act: 'read', at: RUN_AT, runId: 'run-1', unitId: 'u', actorId: 'svc', signature: null }),
      'migration dated to the source': r => { r.events[0].at = r.original.time.value; },
      'supplement before migration': r => r.supplements.push({ act: G.SUPPLEMENT_ACT, at: CAPTURED, signer: signer().identity, contentSha256: r.contentSha256 }),
    };
    for (const [name, forge] of Object.entries(forged)) {
      const back = readBackOf(store), target = findRecord(back.records, 'ReportVersion', UID1, 2);
      forge(target);
      const result = G.reconcileLegacyMigration(plan, back);
      assert.equal(result.status, 'failed', name);
      assert(result.rows.find(r => r.itemKey === target.itemKey).mismatches.some(m => ['events', 'supplements'].includes(m)), name);
    }
  });

  test('TEST-G-03 unsigned_supplement refuse: the same display name does not identify the legacy author', () => {
    const { plan, store, result } = migrated();
    const target = findRecord(result.records, 'ReportVersion', UID1, 2);
    const supplement = G.planLegacySupplement(result, target.itemKey, { signer: signer('dr.kim'), at: later(RUN_AT, 86_400_000), viewed: viewedOf(target) });
    assert.deepEqual(supplement.originalAuthor.identity, { status: 'unresolved', reason: 'legacy-display-only' },
      'M-G-02: a signer whose display name equals the legacy author string is not that author');
    assert.deepEqual([supplement.signer, supplement.originalAuthor.values], [signer('dr.kim').identity, ['dr.kim']]);
    const back = readBackOf(store), named = back.records.find(r => r.itemKey === target.itemKey);
    named.marking.author.identity = { status: 'known', value: signer('dr.kim').identity };
    const invented = G.reconcileLegacyMigration(plan, back);
    assert(invented.rows.find(r => r.itemKey === target.itemKey).mismatches.includes('marking'), 'an invented author identity fails reconciliation');
  });

  test('TEST-G-03 unsigned_supplement refuse: changed wording, unconfirmed provenance, missing authority, past time and drafts are refused', () => {
    const { plan, store, result } = migrated();
    const target = findRecord(result.records, 'ReportVersion', UID1, 2), at = later(RUN_AT, 86_400_000), before = structuredClone(result.records);
    const request = (over = {}) => ({ signer: signer(), at, viewed: viewedOf(target), ...over });
    const refusals = [
      [target.itemKey, request({ viewed: { ...viewedOf(target), contentSha256: sha('edited wording') } }), 'SupplementContentChanged'],
      [target.itemKey, request({ viewed: { ...viewedOf(target), rowSha256: sha('other row') } }), 'SupplementProvenanceUnconfirmed'],
      [target.itemKey, request({ viewed: { ...viewedOf(target), snapshotId: 'snap-other' } }), 'SupplementProvenanceUnconfirmed'],
      [target.itemKey, request({ signer: signer('dr.choi', { roles: ['clinician'] }) }), 'SupplementAuthorityRefused'],
      [target.itemKey, request({ signer: signer('dr.choi', { canSign: false }) }), 'SupplementAuthorityRefused'],
      [target.itemKey, request({ signer: signer('dr.choi', { canReadStudy: false }) }), 'SupplementAuthorityRefused'],
      [target.itemKey, request({ signer: signer('svc', { kind: 'service' }) }), 'SupplementAuthorityRefused'],
      [target.itemKey, request({ at: CAPTURED }), 'SupplementTimeRefused'],
      [result.records.find(r => r.model === 'ReportDraft').itemKey, request(), 'SupplementNotApplicable'],
      ['legacy:' + '0'.repeat(64), request(), 'LegacyRecordRequired'],
    ];
    for (const [itemKey, body, code] of refusals) assert.equal(refusal(() => G.planLegacySupplement(result, itemKey, body)), code, code);
    assert.deepEqual(result.records, before, 'a refused supplement changes nothing');
    const back = readBackOf(store); back.records.pop();
    assert.equal(refusal(() => G.planLegacySupplement(G.reconcileLegacyMigration(plan, back), target.itemKey, request())), 'ReconciliationFailed');
  });

  test('TEST-G-04 unknown_dates allow: a verified original time stays the retention start; migration and supplement do not move it', () => {
    const { units } = migrated();
    const writes = writesOf(units);
    const { unit, write } = writes.find(({ write: w }) => w.model === 'ReportVersion' && w.original.columns.uid === UID1 && w.sequence === 2);
    const original = '2026-03-02T02:00:00.000Z';
    const years = D.retentionFor([write.kind]).retentionYears;
    assert.deepEqual(write.retention, { status: 'original-start', startedAt: original, classes: D.statutoryClasses([write.kind]), years,
      ownDeadline: D.civilPeriodEnd(original, years) }, 'M-G-01R: the retention start is the stored original time, never the migration time');
    assert.notEqual(write.retention.ownDeadline, D.civilPeriodEnd(unit.at, years));
    const srWrite = writes.find(({ write: w }) => w.model === 'ManualSr').write;
    assert.deepEqual([srWrite.retention.startedAt, srWrite.retention.years], ['2026-03-03T00:00:00.000Z', D.retentionFor([srWrite.kind]).retentionYears]);
    assert.deepEqual(write.lifecycle, { amendWindow: { status: 'not-granted', reason: 'no-verified-original-signer' }, finalization: 'not-asserted', legacyAction: 'approve' });
  });

  test('TEST-G-04 unknown_dates refuse: an unverified time stays unresolved, is not destroyable and grants no 24-hour window', () => {
    const rows = baseRows();
    rows[1] = { ...rows[1], timeBasis: 'unverified', columns: { ...rows[1].columns, at: '2026-03-02 11:00:00' } };
    const { plan, units } = migrated(rows);
    const { write } = writesOf(units).find(({ write: w }) => w.model === 'ReportVersion' && w.original.columns.uid === UID1 && w.sequence === 2);
    assert.deepEqual(write.lifecycle.amendWindow, { status: 'not-granted', reason: 'original-time-unresolved' },
      'M-G-06: an unknown approval time grants no 24-hour amendment counted from the migration');
    assert.equal(write.lifecycle.finalization, 'not-asserted');
    assert.deepEqual(write.original.time, { value: '2026-03-02 11:00:00', basis: 'unverified' }, 'the stored value is kept as read');
    assert.deepEqual(write.retention, { status: 'unresolved', fact: 'original-time', destroyable: false });
    const fact = plan.unresolved.find(f => f.itemKey === write.itemKey);
    assert.deepEqual([fact.fact, fact.blocksAcceptance, fact.followUp.owner], ['original-time', false, 'records-manager']);
    for (const { write: w } of writesOf(units)) {
      assert.equal(w.lifecycle.amendWindow.status, 'not-granted');
      assert(w.retention.status === 'unresolved' ? w.retention.destroyable === false : w.retention.ownDeadline === D.civilPeriodEnd(w.retention.startedAt, w.retention.years));
    }
  });

  test('TEST-G-04 unknown_dates: classification and civil-period boundaries are consumed from A without a G period table', () => {
    // D-19/D-21 correction is owned by B1/A. This consumer test runs against whichever A is actually bound;
    // passing on the frozen base does not claim the new five-year/first-day legal acceptance has landed there.
    const times = ['2024-02-28T15:00:00.000Z', '2024-02-29T03:00:00.000Z',
      '2025-01-31T14:59:59.999Z', '2025-01-31T15:00:00.000Z', '2025-12-31T14:59:59.999Z',
      '2025-12-31T15:00:00.000Z', '2026-10-08T15:00:00.000Z', '2026-10-09T03:00:00.000Z'];
    for (const original of times) {
      const rows = baseRows();
      for (const row of rows) row.columns[G.LEGACY_SOURCES[row.model].time] = original;
      const { units } = migrated(rows);
      for (const { write } of writesOf(units)) {
        if (write.model === 'ReportDraft') {
          assert.deepEqual(write.retention, { status: 'unresolved', fact: 'purpose-end', destroyable: false });
          continue;
        }
        const kinds = C.classifyModel(write.model).filter(k => C.RECORD_CLASSIFICATION[k].retention.mode !== 'source-record');
        const years = D.retentionFor(kinds).retentionYears;
        assert.deepEqual(write.retention, { status: 'original-start', startedAt: original,
          classes: D.statutoryClasses(kinds), years, ownDeadline: D.civilPeriodEnd(original, years) });
        assert.equal(write.lifecycle.amendWindow.status, 'not-granted');
      }
    }
  });

  test('TEST-G-04 unknown_dates: A refuses migration and same-content supplement events as a retention start', () => {
    const rows = new Map();
    const capabilities = M.composeEmrAdapters({
      stored: { load: (recordId, eventId) => rows.get(recordId + ':' + eventId) },
      legal: { load: () => undefined, listHolds: recordId => ({ recordId, holdIds: [], complete: true }) },
      purpose: { load: () => undefined, loadSignedResult: () => undefined },
      clinical: { loadStudy: () => undefined, loadReportPatient: () => undefined },
    });
    const at = '2026-10-09T05:00:00.000Z', hash = sha('legacy-text');
    const stored = (eventId, act, signed) => {
      rows.set('legacy-report-1:' + eventId, { recordId: 'legacy-report-1', model: 'ReportVersion', row: {}, event: { eventId, recordId: 'legacy-report-1',
        versionId: 'v-' + eventId, sha256: hash, contentSha256: hash, at, act,
        signature: signed ? { versionId: 'v-' + eventId, sha256: hash, signedAt: at, verified: true } : null, predecessor: null, components: [], processing: null } });
      return C.resolveStoredRecord(capabilities.stored, 'legacy-report-1', eventId);
    };
    assert.equal(refusal(() => D.newRetentionRecord(stored('migration', G.MIGRATION_ACT, false))), 'NewLawfulRecordEventRequired');
    assert.equal(refusal(() => D.newRetentionRecord(stored('supplement', G.SUPPLEMENT_ACT, true))), 'NewLawfulRecordEventRequired');
    assert.equal(D.newRetentionRecord(stored('entry', 'entry', true)).parts[0].startedAt, at, 'a real signed entry does start a clock');
  });

  test('TEST-G-04 unknown_dates: every open fact goes to records staff with a follow-up, never to the reading doctor', () => {
    const rows = baseRows();
    rows[0] = { ...rows[0], timeBasis: 'unverified' };
    rows[2].columns.findings = 'head wording that no version holds';
    rows[3].institution = { status: 'unresolved', reason: 'not-determined' };
    rows[4] = { ...rows[4], patient: { status: 'unresolved', reason: 'no-matched-order' } };
    rows[7] = sr('00000000-0000-4000-8000-0000000000d1', { orthancId: null },
      [{ objectKey: 'database-bytes', present: true, sha256: sha('other bytes') }, { objectKey: 'orthanc-instance', present: false, sha256: null }]);
    rows.push(draft(UID2, 'dr.oh', '', 'false'), draft(UID2, 'dr.yu', 'left after clearing', 'false'));
    const plan = planOf(snapshot(rows));
    assert.deepEqual(plan.unresolved.map(f => [f.model, f.fact, f.reason, f.blocksAcceptance]).sort(), [
      ['ManualSr', 'source-object', 'object-hash-mismatch', true],
      ['ManualSr', 'source-object', 'object-missing', true],
      ['Report', 'head-version-divergence', 'text-differs', false],
      ['ReportDraft', 'draft-presence', 'content-on-cleared-draft', false],
      ['ReportDraft', 'managing-institution', 'not-determined', true],
      ['ReportDraft', 'purpose-end', 'no-recorded-purpose-end', false],
      ['ReportDraft', 'purpose-end', 'no-recorded-purpose-end', false],
      ['ReportVersion', 'original-time', 'timezone-or-writer-unverified', false],
      ['ReportVersion', 'patient-link', 'no-matched-order', true],
    ].sort());
    for (const f of plan.unresolved) {
      assert(G.FOLLOW_UP_OWNERS.includes(f.followUp.owner) && f.followUp.owner !== 'radiologist', f.fact);
      assert.equal(typeof f.followUp.action, 'string');
      assert(f.followUp.action.trim());
    }
    assert.deepEqual(plan.excluded.map(e => [e.model, JSON.parse(e.sourceKey)[1], e.reason]), [['ReportDraft', 'dr.oh', 'cleared-draft-boundary']]);
    assert.deepEqual([plan.counts.rows, plan.counts.migrate + plan.counts.excluded], [rows.length, rows.length], 'no row is silently dropped');
  });

  test('TEST-G-05 consumer_reopen allow: current and past versions reopen with original facts, marking and provenance, without a supplement', () => {
    const { result } = migrated();
    const views = result.records.map(r => ({ itemKey: r.itemKey, recordId: r.target.recordId, versionId: r.target.versionId, patient: r.patient.value,
      columns: r.original.columns, time: r.original.time, marking: r.marking, objects: r.objects }));
    assert.deepEqual(G.acceptLegacyReopen(result, { complete: true, views }), { accepted: true, records: 5, versions: 8, supplementsRequired: 0 });
  });

  test('TEST-G-05 consumer_reopen refuse: a missing SR object or another patient\'s link cannot be accepted as a successful migration', () => {
    const viewsOf = result => result.records.map(r => ({ itemKey: r.itemKey, recordId: r.target.recordId, versionId: r.target.versionId,
      patient: r.patient.status === 'known' ? r.patient.value : null, columns: r.original.columns, time: r.original.time, marking: r.marking, objects: r.objects }));
    const rows = baseRows();
    rows[7] = sr('00000000-0000-4000-8000-0000000000d1', { orthancId: null },
      [{ objectKey: 'database-bytes', present: true, sha256: SR_SHA }, { objectKey: 'orthanc-instance', present: false, sha256: null }]);
    const missing = migrated(rows).result;
    assert.notEqual(missing.status, 'failed', 'the record is preserved as it is');
    assert.equal(refusal(() => G.acceptLegacyReopen(missing, { complete: true, views: viewsOf(missing) })), 'ReopenBlockedByUnresolved');
    const missingSr = missing.records.find(r => r.model === 'ManualSr');
    assert.equal(refusal(() => G.planLegacySupplement(missing, missingSr.itemKey,
      { signer: signer(), at: tick(), viewed: viewedOf(missingSr) })), 'SupplementBlockedByUnresolved');

    const { plan, store, result } = migrated();
    const target = findRecord(result.records, 'ReportVersion', UID1, 2);
    const variants = {
      'another patient': views => { views.find(v => v.itemKey === target.itemKey).patient = PATIENT_B; },
      'past version absent': views => { views.splice(views.findIndex(v => v.itemKey === findRecord(result.records, 'ReportVersion', UID1, 1).itemKey), 1); },
      'marking dropped': views => { views.find(v => v.itemKey === target.itemKey).marking = { ...target.marking, status: 'signed' }; },
      'wording changed': views => { const v = views.find(x => x.itemKey === target.itemKey); v.columns = { ...v.columns, findings: v.columns.findings.replace('  ', ' ') }; },
    };
    for (const [name, change] of Object.entries(variants)) {
      const views = structuredClone(viewsOf(result)); change(views);
      assert.equal(refusal(() => G.acceptLegacyReopen(result, { complete: true, views })), 'ReopenViewMismatch', name);
    }
    assert.equal(refusal(() => G.acceptLegacyReopen(result, { complete: false, views: viewsOf(result) })), 'ReopenViewIncomplete');
    const back = readBackOf(store); findRecord(back.records, 'ReportVersion', UID2, 1).patient = known(PATIENT_A);
    assert.equal(refusal(() => G.acceptLegacyReopen(G.reconcileLegacyMigration(plan, back), { complete: true, views: viewsOf(result) })), 'ReconciliationFailed');
  });
  if (listing) process.stdout.write(JSON.stringify(declaredCases) + '\n');
}
