/* D889 B -> RISK-EMR-STALE-WRITER -> LOCK-01.
 * Linux production image, real flock(1), independent processes, no DB. */
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const cp = require('node:child_process'), assert = require('node:assert/strict');
const { lockFile } = require('/app/dist/emr-runtime/file-lock');
const { StateCoordinator } = require('/app/dist/emr-runtime/coordinator');
if (['child', 'crash', 'crash-journal'].includes(process.argv[2])) {
  const owner = new StateCoordinator(process.argv[3]);
  if (process.argv[2].startsWith('crash')) {
    const writer = require('/app/dist/emr-runtime/external-writer'), execute = writer.executeExternal;
    writer.executeExternal = request => {
      const result = execute(request);
      if (request.operation === (process.argv[2] === 'crash' ? 'compare-and-set' : 'journal-record')) process.exit(0);
      return result;
    };
  }
  process.stdout.write(owner.ownerId + '\n');
  setInterval(() => {}, 1000);
} else {
  (async () => {
    assert(fs.existsSync('/usr/bin/flock'), 'existing util-linux runtime lock');
    assert(!fs.existsSync('/usr/bin/gcc'), 'runtime has no compiler');
    assert(!fs.existsSync('/app/native/flock.node'), 'runtime has no private native addon');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emr-lock-'));
    let child;
    try {
      child = cp.spawn(process.execPath, [__filename, 'child', dir], { stdio: ['ignore', 'pipe', 'inherit'] });
      const owner = await new Promise((resolve, reject) => {
        child.stdout.once('data', value => resolve(value.toString().trim())); child.once('error', reject);
      });
      const holder = new StateCoordinator(dir);
      assert(holder.ownerAlive(owner), 'child retains the inherited open-file-description lock after flock exits');
      holder.call('journal-record', { id: 'peer', kind: 'ledger-unavailable', body: { eventId: 'synthetic', cause: 'commit-unknown' } });
      const state = holder.call('read');
      const changed = holder.call('update', current => { current.generation++; return current.generation; });
      assert.equal(changed.result, state.generation + 1, 'peer closures publish through fenced CAS over IPC');
      assert.equal(holder.call('compare-and-set', { before: state.revision, state }).changed, false, 'stale IPC write is refused');
      const dead = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await dead;
      assert.equal(holder.ownerAlive(owner), false, 'OS death releases ownership without a lease');
      assert.equal(holder.call('read').generation, state.generation + 1, 'surviving peer acquires a fresh fence and recovers durable state');
      const next = new StateCoordinator(dir);
      assert(!fs.existsSync(path.join(dir, 'owners', owner)), 'startup sweeps the dead owner under the writer fence');
      assert(next.ownerAlive(holder.ownerId), 'startup preserves other live owners');
      assert.equal(next.call('journal-find', 'peer').id, 'peer', 'replacement owner preserves the peer record');
      const uncertain = path.join(dir, 'response-unknown'); fs.mkdirSync(uncertain, { mode: 0o700 });
      child = cp.spawn(process.execPath, [__filename, 'crash', uncertain], { stdio: ['ignore', 'pipe', 'inherit'] });
      await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
      const peer = new StateCoordinator(uncertain), before = peer.call('read').generation;
      assert.throws(() => peer.call('update', current => { current.generation++; }), { code: 'SealUnavailable' },
        'death after durable mutation but before reply never fabricates success');
      assert.equal(peer.call('read').generation, before + 1, 'replacement recovers once without replaying an ambiguous mutation');
      const journalDeath = path.join(dir, 'journal-response-unknown'); fs.mkdirSync(journalDeath, { mode: 0o700 });
      child = cp.spawn(process.execPath, [__filename, 'crash-journal', journalDeath], { stdio: ['ignore', 'pipe', 'inherit'] });
      await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
      const journalPeer = new StateCoordinator(journalDeath);
      const record = { id: 'response-unknown', kind: 'ledger-unavailable', body: { eventId: 'synthetic', cause: 'commit-unknown' } };
      assert.equal(journalPeer.call('journal-record', record).id, record.id, 'owner death preserves a keyed journal operation');
      assert.equal(journalPeer.call('journal-load').records.length, 1, 'durable-but-unanswered journal record is never duplicated');
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
        failedAcquisitionRefused: true, survivingPeerTakesOver: true, ambiguousMutationRefused: true, keyedJournalRecoveredOnce: true, deadOwnersSwept: true, liveOwnersPreserved: true,
        flock_pair_us: { p50: samples[49], p95: samples[94], p99: samples[98] } }));
    } finally { if (child?.exitCode === null) child.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
