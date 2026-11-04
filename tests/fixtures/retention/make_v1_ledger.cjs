/* CD-09-C: the format-1 draft destruction ledgers that the CD-09-P release (1f8249a) itself writes, kept as fixtures.
 *
 * The C pure tests (tests/emr/retention/draft_purpose_test.cjs, section C) read these bytes as a P server's ledger before
 * an upgrade. They are not hand-written: this script loads the P release's own product code (draft-purpose.ts and A's
 * lawful-defaults.ts of that tree) and drives the same append path the P destruction uses (decidePurposeEnd, whose A
 * journal appends to PurposeLedgerFile). Synthetic rows only.
 *
 * Generated with (from the C checkout, the P tree extracted by `git archive 1f8249a api/src api/tsconfig.json`):
 *   python scripts/record-run.py --run-dir tmp/cd-09c/fixture-v1 --cwd . -- \
 *     node tests/fixtures/retention/make_v1_ledger.cjs tmp/cd-09c/p-1f8249a/api tests/fixtures/retention 1f8249a05999459fef112b39f92ce72afa387b17
 *
 * Output: v1-closed.jsonl (two units, one failed attempt then a completed one), v1-open-started.jsonl (the same, then a
 * started record whose commit could not be judged, as a P server stopped there leaves it) and v1-fixtures.json (the
 * ledger ID, the units, the anchor the database holds for each file, and the SHA-256 of the P sources that wrote them).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const [apiArg, outArg, sourceSha] = process.argv.slice(2);
if (!apiArg || !outArg || !/^[0-9a-f]{40}$/.test(sourceSha ?? '')) {
  console.error('usage: make_v1_ledger.cjs <P api dir> <out dir> <P commit SHA>');
  process.exit(2);
}
const api = path.resolve(apiArg), out = path.resolve(outArg);
const ts = require(path.join(api, 'node_modules/typescript'));
const config = ts.readConfigFile(path.join(api, 'tsconfig.json'), ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, api);
require.extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'),
  { compilerOptions: parsed.options, fileName: filename }).outputText, filename);
const M = require(path.join(api, 'src/emr-contract/composition.ts'));
const CTX = require(path.join(api, 'src/emr-runtime/context.ts'));
const A = require(path.join(api, 'src/emr-contract/lawful-defaults.ts'));
const P = require(path.join(api, 'src/emr-retention/draft-purpose.ts'));
M.composeEmrAdapters(CTX.runtimeAdapters);

const AUTHOR = 'syn-reader@synthetic.test';
const noFacts = () => ({ holds: [], accessRequests: new Map(), correctionRequests: new Map(), clauseVersions: new Map(), signed: null });
const row = (unit, endedAt) => ({ disposalUnitId: unit, uid: '2.25.990009', author: AUTHOR, workSince: new Date('2026-11-01T00:00:00.000Z'),
  workIntent: 'approve', trigger: 'explicit-discard', eventId: randomUUID(), actorId: AUTHOR, endedAt: new Date(endedAt),
  signedRecordId: null, signedVersionId: null, findings: 'SYN v1 fixture', conclusion: '', recommendation: '', baseVersion: 0,
  citations: null, structured: null, deliverySettled: true, attempts: 0, lastRefusal: null });

async function write(file, steps) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd09c-v1-'));
  const ledger = new P.PurposeLedgerFile(dir), ledgerId = steps.ledgerId;
  ledger.create(ledgerId);
  // The P destruction's own append (draft-purpose.ts destroyLocked): A's journal record goes to ledger.append.
  const store = { append: async event => ({ durableAt: ledger.append(ledgerId, event).durableAt }) };
  for (const step of steps.attempts) {
    try {
      await P.decidePurposeEnd(store, step.row, noFacts(), step.at, async () => {
        if (step.outcome === 'failed') throw new Error('SYN deletion rolled back');
        if (step.outcome === 'unknown') throw new A.CommitOutcomeUnknown();
        return { completedAt: step.completedAt, method: 'irreversible-permanent-deletion' };
      });
    } catch (error) { if (step.outcome === 'completed') throw error; }
  }
  fs.copyFileSync(ledger.file, path.join(out, file));
  return fs.readFileSync(ledger.file);
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const ledgerId = randomUUID(), a = 'disposal:' + randomUUID(), b = 'disposal:' + randomUUID(), c = 'disposal:' + randomUUID();
  const rowA = row(a, '2026-11-02T00:10:00.000Z'), rowB = row(b, '2026-11-02T00:20:00.000Z'), rowC = row(c, '2026-11-02T00:30:00.000Z');
  const closed = [
    { row: rowA, at: '2026-11-02T01:00:00.000Z', outcome: 'completed', completedAt: '2026-11-02T01:00:01.000Z' },
    { row: rowB, at: '2026-11-02T02:00:00.000Z', outcome: 'failed' },
    { row: rowB, at: '2026-11-02T02:30:00.000Z', outcome: 'completed', completedAt: '2026-11-02T02:30:01.000Z' },
  ];
  const closedBytes = await write('v1-closed.jsonl', { ledgerId, attempts: closed });
  const openBytes = await write('v1-open-started.jsonl', { ledgerId,
    attempts: [...closed, { row: rowC, at: '2026-11-02T03:00:00.000Z', outcome: 'unknown' }] });
  const sha = file => createHash('sha256').update(fs.readFileSync(path.join(api, file))).digest('hex');
  const meta = {
    generator: 'tests/fixtures/retention/make_v1_ledger.cjs', sourceCommit: sourceSha,
    sources: { 'src/emr-retention/draft-purpose.ts': sha('src/emr-retention/draft-purpose.ts'),
      'src/emr-contract/lawful-defaults.ts': sha('src/emr-contract/lawful-defaults.ts') },
    ledgerId, units: { a, b, c },
    // What the database's PurposeLedgerAnchor holds beside each file: the destruction of B moved it to seq 6.
    closed: { file: 'v1-closed.jsonl', sha256: createHash('sha256').update(closedBytes).digest('hex'),
      anchor: { seq: 6, lastCompletedUnit: b, lastCompletedAt: '2026-11-02T02:30:01.000Z' } },
    // The started record of C is seq 7. Its deletion committed (R1: the anchor names C at seq 8) or nothing proves it (R4).
    openStarted: { file: 'v1-open-started.jsonl', sha256: createHash('sha256').update(openBytes).digest('hex'), startedSeq: 7,
      committedAnchor: { seq: 8, lastCompletedUnit: c, lastCompletedAt: '2026-11-02T03:00:01.000Z' },
      uncommittedAnchor: { seq: 6, lastCompletedUnit: b, lastCompletedAt: '2026-11-02T02:30:01.000Z' } },
  };
  fs.writeFileSync(path.join(out, 'v1-fixtures.json'), JSON.stringify(meta, null, 2) + '\n');
  console.log(JSON.stringify({ ledgerId, closed: meta.closed.sha256, openStarted: meta.openStarted.sha256 }));
})().catch(error => { console.error(error); process.exit(1); });
