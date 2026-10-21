/* D889 B -> RISK-EMR-STALE-WRITER -> LOCK-01.
 * Linux production image, real flock(1), independent processes, no DB.
 * EMR-B2 (c): the coordinator is the state service's local primitive alone - there is no API or retention role on the
 * fence any more (clients reach the service over its sockets), so the only lifetime-fence relation between processes
 * is one owner per state directory: a second process on the same directory is refused while the first lives and
 * acquires only after its death. Every owner process initializes its pristine directory the way the service does
 * (AccessSeal.recoverAtStart over a fixed synthetic pair and two empty chains): v3 state exists only through that
 * fenced initialization, so a bare mutation of an empty directory is refused, not performed. The B1 peer/IPC
 * relations (a non-owner's closures published over the owner's fence, owner death between a durable mutation and its
 * reply) have no coordinator counterpart in (c): the service owns the fence alone and clients reach it over the
 * socket protocol (state_service_test.cjs, state_protocol_test.cjs cover those outcomes). */
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const cp = require('node:child_process'), assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { lockFile } = require('/app/dist/emr-runtime/file-lock');
const { StateCoordinator } = require('/app/dist/emr-runtime/coordinator');
const { AccessSeal } = require('/app/dist/emr-runtime/seal');
const { FailureJournal } = require('/app/dist/emr-runtime/failure-journal');

const CHAINS = { viewing: '7c1f3a52-0000-4000-8000-000000000001', history: '7c1f3a52-0000-4000-8000-000000000002' };
const IDENTITY = { database: 'synthetic', oid: 42, address: '127.0.0.1', port: 5432 };
const PAIR = { instanceId: 'lock-test-synthetic-pair', chains: { ...CHAINS }, database: { ...IDENTITY } };
/** Two empty chains of fixed identity, as a new database holds them: enough for the service's own initialization. */
function memorySql() {
  const sql = {
    identity: async () => ({ ...IDENTITY }),
    snapshot: async work => work(sql), withWriterFence: async work => work(sql),
    markerForSlot: async () => null, markerForAttempt: async () => null,
    tail: async stream => ({ chainId: CHAINS[stream], sequence: 0, hash: '0'.repeat(64) }),
    entriesAfter: async () => [], entryForEvent: async () => null, placement: async () => [],
  };
  sql.verificationPage = async stream => ({ tail: await sql.tail(stream), first: null, entries: [] });
  return sql;
}
/** The product's own pristine initialization under this owner's fence (seal.ts recoverAtStart). */
async function initialize(owner) {
  const journal = new FailureJournal(owner.directory, owner);
  await new AccessSeal(owner.directory, memorySql(), journal).recoverAtStart(PAIR, randomUUID());
}
function inventory(directory) {
  const found = {};
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) for (const [name, hash] of Object.entries(inventory(file))) found[entry.name + '/' + name] = hash;
    else if (entry.isFile()) found[entry.name] = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }
  return found;
}

if (['child', 'child-journal'].includes(process.argv[2])) {
  (async () => {
    const owner = new StateCoordinator(process.argv[3]);
    await initialize(owner);
    // An owner that recorded durable work before its death: the successor must find exactly that record.
    if (process.argv[2] === 'child-journal') owner.call('journal-record', { id: 'before-death', kind: 'ledger-unavailable', body: { eventId: 'synthetic', cause: 'commit-unknown' } });
    process.stdout.write(owner.ownerId + '\n');
    setInterval(() => {}, 1000);
  })().catch(error => { console.error(error); process.exit(1); });
} else {
  (async () => {
    assert(fs.existsSync('/usr/bin/flock'), 'existing util-linux runtime lock');
    assert(!fs.existsSync('/usr/bin/gcc'), 'runtime has no compiler');
    assert(!fs.existsSync('/app/native/flock.node'), 'runtime has no private native addon');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emr-lock-'));
    let child;
    const spawnOwner = (mode, directory) => {
      child = cp.spawn(process.execPath, [__filename, mode, directory], { stdio: ['ignore', 'pipe', 'inherit'] });
      return new Promise((resolve, reject) => {
        child.stdout.once('data', value => resolve(value.toString().trim()));
        child.once('error', reject);
        child.once('exit', code => reject(new Error('owner process ended before it was ready: ' + code)));
      });
    };
    try {
      // A bare mutation of an empty directory is refused: v3 state exists only through the fenced initialization.
      const bare = path.join(dir, 'bare'); fs.mkdirSync(bare, { mode: 0o700 });
      const bareOwner = new StateCoordinator(bare);
      assert.throws(() => bareOwner.call('update', state => { state.generation++; }), { code: 'SealMissing' }, 'no state without initialization');
      assert.throws(() => bareOwner.call('journal-record', { id: 'x', kind: 'ledger-unavailable', body: {} }), { code: 'SealMissing' }, 'no journal without initialization');
      // EMR-B2 (c): one owner per state directory. A second process on the directory of a living owner is refused
      // at construction, performs no protected write and takes nothing; after the owner's death the same directory
      // admits the next owner, which recovers the durable state the first one published.
      const ordered = path.join(dir, 'second-owner'); fs.mkdirSync(ordered, { mode: 0o700 });
      await spawnOwner('child', ordered);
      const published = inventory(ordered);
      assert(Object.keys(published).some(name => name.startsWith('seal/')), 'the owner initialized and published the pristine pair');
      const started = performance.now();
      assert.throws(() => new StateCoordinator(ordered), { code: 'SealUnavailable' }, 'same-directory second owner is refused while the first lives');
      assert(performance.now() - started < 10000, 'the refusal is bounded');
      assert.deepEqual(inventory(ordered), published, 'refused second owner performs no protected write');
      const firstExit = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await firstExit;
      const successor = new StateCoordinator(ordered), inherited = successor.call('read');
      assert.equal(inherited.lineage.origin.instanceId, PAIR.instanceId, 'the successor recovers the lineage the dead owner published');
      const advanced = successor.call('update', state => { state.generation++; return state.generation; });
      assert.equal(advanced.result, inherited.generation + 1, 'after the owner dies the same directory admits the next owner over its durable state');
      const stale = successor.call('compare-and-set', { before: inherited.revision, state: inherited });
      assert.equal(stale.changed, false, 'a stale compare-and-set is refused');
      successor.close();
      assert.throws(() => successor.call('read'), { code: 'SealUnavailable' }, 'a closed coordinator refuses every call');
      // The fence survives close until process death: the same process cannot re-acquire the directory it closed, and
      // a second process is still refused (the lock is this process's for its lifetime).
      assert.throws(() => new StateCoordinator(ordered), { code: 'SealUnavailable' }, 'the lifetime fence outlives close');
      // An owner that recorded durable work and died: the successor finds exactly that record, never a duplicate.
      const journaled = path.join(dir, 'journal-before-death'); fs.mkdirSync(journaled, { mode: 0o700 });
      await spawnOwner('child-journal', journaled);
      const beforeDeath = inventory(journaled);
      const journalExit = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await journalExit;
      assert.deepEqual(inventory(journaled), beforeDeath, 'OS death leaves the durable bytes as the owner last published them');
      const heir = new StateCoordinator(journaled);
      assert.equal(heir.call('journal-find', 'before-death').id, 'before-death', 'the successor preserves the dead owner\'s keyed journal record');
      assert.equal(heir.call('journal-load').records.length, 1, 'the record is recovered once, never duplicated');
      const lock = path.join(dir, 'probe'), fd = fs.openSync(lock, 'a+', 0o600);
      lockFile(fd, true);
      const contender = fs.openSync(lock, 'a+', 0o600);
      assert.equal(lockFile(contender, true, true), false, 'independent open description cannot enter');
      fs.closeSync(fd);
      assert(lockFile(contender, true, true), 'closing parent descriptor releases lock'); fs.closeSync(contender);
      assert.throws(() => lockFile(-1, true), { code: 'SealUnavailable' });
      const spawn = cp.spawnSync;
      cp.spawnSync = () => ({ status: null, signal: 'SIGKILL' });
      try {
        const refused = path.join(dir, 'failed-acquisition'); fs.mkdirSync(refused, { mode: 0o700 });
        assert.throws(() => new StateCoordinator(refused), { code: 'SealUnavailable' });
        assert(!fs.existsSync(path.join(refused, 'journal')), 'failed acquisition performs no protected write');
      } finally { cp.spawnSync = spawn; }
      const samples = [];
      for (let i = 0; i < 100; i++) {
        const started = performance.now(), fd = fs.openSync(lock, 'a+', 0o600);
        lockFile(fd, true); fs.closeSync(fd); samples.push((performance.now() - started) * 1000);
      }
      samples.sort((a, b) => a - b);
      console.log(JSON.stringify({ case: 'LOCK-01', cycles: samples.length, processDeathReleased: true,
        failedAcquisitionRefused: true, keyedJournalRecoveredOnce: true, staleCompareAndSetRefused: true, closedCoordinatorRefuses: true, fenceOutlivesClose: true,
        sameDirectorySecondOwnerRefused: true, deadOwnerDirectoryAdmitsSuccessor: true, bareMutationRefused: true,
        flock_pair_us: { p50: samples[49], p95: samples[94], p99: samples[98] } }));
    } finally { if (child?.exitCode === null) child.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
