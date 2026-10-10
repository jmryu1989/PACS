/* REQ-EMR-B-THROUGHPUT -> RISK-READING-RECEIPT-LATENCY -> L03/L03b.
 * Boundary timings only: production store/seal code is unchanged by this probe.
 * The disposable DB supplies a diagnostic function acquiring the same head lock;
 * its server clock measures lock wait separately from client scheduling and SQL.
 */
const fs = require('node:fs');
const cp = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { AsyncLocalStorage } = require('node:async_hooks');
const clock = () => performance.now();
const round = n => Math.round(n * 1000) / 1000;
const disk = { write_ms: 0, fsync_ms: 0, writes: 0, fsyncs: 0 };
let activeScope;
for (const [name, field, count] of [['writeFileSync', 'write_ms', 'writes'], ['fsyncSync', 'fsync_ms', 'fsyncs'], ['fdatasyncSync', 'fsync_ms', 'fsyncs']]) {
  const original = fs[name];
  fs[name] = function (...args) { const start = clock(); try { return original.apply(this, args); }
    finally {
      const elapsed = clock() - start; disk[field] += elapsed; disk[count]++;
      const row = activeScope?.getStore();
      if (row) { row[field] += elapsed; row[count]++; row.spans.push([start, start + elapsed, field]); }
    } };
}
if (process.env.EMR_TIMING_CHILD === '1') process.on('exit', () => fs.writeSync(2, 'EMR_DISK ' + JSON.stringify(disk) + '\n'));

function instrument(prisma, store, seal, { headProbe = false } = {}) {
  const scope = new AsyncLocalStorage(), originalSpawn = cp.spawnSync;
  const drains = [], pending = new Map(), restorers = [];
  const newRow = () => ({ head_lock_wait_ms: 0, head_lock_and_sql_ms: 0, pool_wait_ms: 0,
    commit_ms: 0, admission_wait_ms: 0, verification_sql_ms: 0, coordinator_ms: 0,
    writer_ms: 0, write_ms: 0, fsync_ms: 0, writes: 0, fsyncs: 0, transactions: [], spans: [] });
  // A drain's async context belongs to its whole committed group, not to the
  // first requester that happened to schedule it. Link its costs explicitly to
  // every covered request; never charge the leader with other groups' snapshots.
  if (typeof seal.advanceReceipt === 'function' && typeof seal.reconcileState === 'function') {
    const advance = seal.advanceReceipt.bind(seal), reconcile = seal.reconcileState.bind(seal);
    seal.advanceReceipt = async (stream, attempt, eventId, entry) => {
      const row = scope.getStore(), key = stream + ':' + attempt;
      if (row) pending.set(key, { row, stream, sequence: entry.sequence, queued: clock() });
      try { return await advance(stream, attempt, eventId, entry); } finally { pending.delete(key); }
    };
    seal.reconcileState = (stream, target, ...rest) => {
      const members = [...pending.values()].filter(p => !p.assigned && p.stream === stream && p.sequence <= (target?.sequence ?? Infinity));
      // Resolution callbacks run in a later microtask. The next group may start
      // before those callbacks remove the previous members from pending.
      for (const member of members) member.assigned = true;
      const direct = scope.getStore();
      if (!members.length && direct?.kind === 'request') members.push({ row: direct });
      const group = { ...newRow(), kind: 'drain', id: 'drain-' + (drains.length + 1), stream,
        through: target?.sequence, eventIds: [...new Set(members.map(p => p.row.eventId))] };
      drains.push(group);
      for (const { row, queued } of members) {
        (row.drain_groups ||= []).push(group.id);
        if (queued !== undefined) row.spans.push([queued, clock(), 'drain_queue']);
      }
      group.started = clock();
      return scope.run(group, async () => {
        try { return await reconcile(stream, target, ...rest); }
        finally {
          group.ended = clock(); group.elapsed_ms = group.ended - group.started;
          group.verification_sql_ms = Object.entries(group).filter(([k]) => k.startsWith('sql_')).reduce((n, [, v]) => n + v, 0);
        }
      });
    };
    restorers.push(() => { seal.advanceReceipt = advance; seal.reconcileState = reconcile; });
  }
  activeScope = scope;
  // The pinned r3 seal serializes confirmation callbacks. Measure its actual
  // queue handoff, just as current grouped drains expose their enqueue/start.
  if (typeof seal.serial === 'function') {
    const serial = seal.serial;
    seal.serial = function (work) {
      const row = scope.getStore(), queued = clock();
      return serial.call(this, (...args) => {
        if (row) row.spans.push([queued, clock(), 'seal_queue']);
        return work(...args);
      });
    };
    restorers.push(() => { seal.serial = serial; });
  }
  cp.spawnSync = function (command, args, options) {
    const started = clock(), result = originalSpawn.call(this, command, args, { ...options,
      env: { ...process.env, EMR_TIMING_CHILD: '1', NODE_OPTIONS: '--require=' + __filename } });
    const row = scope.getStore();
    if (row) {
      row.writer_ms += clock() - started;
      for (const line of String(result.stderr || '').split('\n').filter(s => s.startsWith('EMR_DISK '))) {
        const d = JSON.parse(line.slice(9));
        for (const k of Object.keys(disk)) row[k] += d[k];
      }
    }
    return result;
  };
  const originalTransaction = prisma.$transaction.bind(prisma);
  prisma.$transaction = async (work, options) => {
    const row = scope.getStore(), start = clock(); let callbackEnd;
    if (row?.admission_started !== undefined) {
      row.admission_wait_ms += start - row.admission_started;
      row.spans.push([row.admission_started, start, 'admission_wait']);
      delete row.admission_started;
    }
    try {
      return await originalTransaction(async tx => {
        if (row) {
          row.pool_wait_ms += clock() - start; row.transactions.push(options || {});
          row.spans.push([start, clock(), 'pool_wait']);
        }
        try { return await work(tx); } finally { callbackEnd = clock(); }
      }, options);
    } catch (error) {
      if (row) (row.transaction_errors ||= []).push({ options, elapsed_ms: round(clock() - start), code: error.code, message: String(error.message) });
      throw error;
    } finally {
      if (row && callbackEnd) {
        const elapsed = clock() - callbackEnd;
        row.commit_ms += elapsed;
        row.spans.push([callbackEnd, callbackEnd + elapsed, 'commit']);
        const field = row.kind === 'drain' ? 'seal_snapshot_commit_ms' : 'append_commit_ms';
        row[field] = (row[field] || 0) + elapsed;
      }
    }
  };
  const method = (object, name, label) => {
    if (typeof object[name] !== 'function') return;
    const original = object[name];
    object[name] = function (...args) {
      const row = scope.getStore(), start = clock();
      const finish = () => { if (row) {
        const end = clock(); row[label] = (row[label] || 0) + end - start;
        if (label !== 'confirm_ms') row.spans.push([start, end, label]);
      } };
      try { const v = original.apply(this, args); if (v && typeof v.then === 'function') return v.finally(finish); finish(); return v; }
      catch (e) { finish(); throw e; }
    };
    restorers.push(() => { object[name] = original; });
  };
  if (typeof store.withAppendTransaction === 'function') {
    const admitted = store.withAppendTransaction.bind(store);
    store.withAppendTransaction = (...args) => {
      const row = scope.getStore(); if (row) row.admission_started = clock();
      return admitted(...args);
    };
    restorers.push(() => { store.withAppendTransaction = admitted; });
  }
  // Snapshot readers construct further PrismaLedgerSql instances. Instrument
  // the prototype as well as object-based model adapters, so no drain SQL hides
  // inside an unattributed confirm span again. Each scope retains method detail.
  const readers = new Set([store.sql, seal.sql].filter(Boolean).map(sql =>
    Object.getPrototypeOf(sql)?.constructor === Object ? sql : Object.getPrototypeOf(sql)));
  for (const reader of readers) for (const name of ['verificationPage', 'entryForEvent', 'tail', 'entriesAfter', 'markerForSlot', 'markerForAttempt'])
    method(reader, name, 'sql_' + name + '_ms');
  if (seal.journal?.coordinator) method(seal.journal.coordinator, 'call', 'coordinator_ms');
  method(store, 'appendInTransaction', 'append_callback_ms');
  for (const name of ['recordIntent', 'recordIntentAsync', 'reserve']) method(seal, name, name + '_ms');
  for (const name of ['bindCommit', 'confirm', 'settle', 'settleTransaction']) method(store, name, name + '_ms');
  const originalAppendRow = store.appendRow.bind(store);
  store.appendRow = async function (tx, stream, ...args) {
    const row = scope.getStore(), start = clock();
    if (headProbe) {
      const [value] = await tx.$queryRaw`SELECT public.emrb_measure_lock(${stream}::text) AS wait_ms`;
      if (row) row.head_lock_wait_ms += Number(value.wait_ms);
    }
    try { return await originalAppendRow(tx, stream, ...args); }
    finally { if (row) row.head_lock_and_sql_ms += clock() - start; }
  };
  restorers.push(() => { store.appendRow = originalAppendRow; });
  return {
    drains,
    async run(event) {
      const row = { ...newRow(), kind: 'request', eventId: event.eventId, drain_groups: [] };
      const start = clock(), before = { ...disk };
      return scope.run(row, async () => {
        try { row.receipt = await store.append(event); }
        catch (error) { row.error = error.code || error.name; row.error_detail = String(error.message); }
        row.receipt_ms = clock() - start;
        const stop = start + row.receipt_ms;
        const spans = [...row.spans, ...drains.filter(g => row.drain_groups.includes(g.id)).flatMap(g => g.spans)];
        const intervals = spans.map(([a, b]) => [Math.max(start, a), Math.min(stop, b)]).filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
        let covered = 0, end = start;
        for (const [a, b] of intervals) { covered += Math.max(0, b - Math.max(a, end)); end = Math.max(end, b); }
        row.attributed_ms = covered;
        row.attribution_ratio = covered / row.receipt_ms;
        row.unattributed_ms = row.receipt_ms - covered;
        row.verification_sql_ms = Object.entries(row).filter(([k]) => k.startsWith('sql_')).reduce((n, [, v]) => n + v, 0);
        row.local_disk_delta = Object.fromEntries(Object.keys(disk).map(k => [k, disk[k] - before[k]]));
        for (const k of Object.keys(row)) if (typeof row[k] === 'number') row[k] = round(row[k]);
        return row;
      });
    },
    restore() { for (const restore of restorers) restore(); prisma.$transaction = originalTransaction; cp.spawnSync = originalSpawn; activeScope = undefined; },
  };
}
function summary(rows) {
  const times = rows.map(r => r.receipt_ms).sort((a, b) => a - b);
  return { count: rows.length, failures: rows.filter(r => !r.receipt).length, p95_ms: times[Math.ceil(times.length * .95) - 1], max_ms: times.at(-1) };
}
module.exports = { instrument, summary };
