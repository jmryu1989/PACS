/* Opus r4 review: cost of ONE failure-journal record() as the journal grows, r3 (in-memory index, loaded once at start)
 * vs r4c (persistent coordinator index, incrementally refreshed for other writers).
 * Usage: node journal_cost.cjs <r3 checkout> <candidate checkout> <out.json>. Synthetic records only.
 * Second mode (A11 capacity ladder, same file, see "A11 capacity ladder" below):
 *   node --max-old-space-size=3072 journal_cost.cjs --ladder --rung <name|count> --mix <acked|unacked|negative|orphan|ordinary>
 *     --streams <one|two> --out <dir> [--budget-seconds N] [--sample-every N] [--heap-mb N] [--keep-state] */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { spawnSync, spawn } = require('node:child_process');
const ts = require(process.env.KIN_EMR_TYPESCRIPT || path.resolve(__dirname, '../../../api/node_modules/typescript'));
require.extensions['.ts'] = (m, f) => m._compile(ts.transpileModule(fs.readFileSync(f, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, esModuleInterop: true, experimentalDecorators: true }, fileName: f }).outputText, f);
const LADDER = process.argv.includes('--ladder');
const PROBE = process.argv.includes('--recovery-probe');
const [r3, r4b, out] = LADDER || PROBE ? [] : process.argv.slice(2);
const J3 = LADDER || PROBE ? null : require(path.join(r3, 'api/src/emr-runtime/failure-journal.ts'));
const J4 = LADDER || PROBE ? null : require(path.join(r4b, 'api/src/emr-runtime/failure-journal.ts'));
const CO = LADDER || PROBE ? null : require(path.join(r4b, 'api/src/emr-runtime/coordinator.ts')), EW = LADDER || PROBE ? null : require(path.join(r4b, 'api/src/emr-runtime/external-writer.ts'));
const S4 = LADDER || PROBE ? null : require(path.join(r4b, 'api/src/emr-runtime/seal.ts'));
// The candidate (EMR-B2 c) refuses a bare journal record on a directory no seal initialized: the sample initializes the
// pair exactly as the service does (AccessSeal.recoverAtStart over two empty chains of fixed identity), outside the
// timed section. The journal fixture itself is unchanged.
const JCOST_CHAINS = { viewing: '7c1f3a52-0000-4000-8000-00000000c051', history: '7c1f3a52-0000-4000-8000-00000000c052' };
const JCOST_PAIR = { instanceId: 'journal-cost-synthetic-pair', chains: { ...JCOST_CHAINS }, database: { database: 'synthetic', oid: 42, address: '127.0.0.1', port: 5432 } };
function jcostSql() {
  const sql = { identity: async () => ({ ...JCOST_PAIR.database }), snapshot: async work => work(sql), withWriterFence: async work => work(sql),
    markerForSlot: async () => null, markerForAttempt: async () => null, tail: async stream => ({ chainId: JCOST_CHAINS[stream], sequence: 0, hash: '0'.repeat(64) }),
    entriesAfter: async () => [], entryForEvent: async () => null, placement: async () => [] };
  sql.verificationPage = async stream => ({ tail: await sql.tail(stream), first: null, entries: [] });
  return sql;
}
function seed(dir, n) {
  // A protected state directory as the owner keeps it: private subdirectories (the candidate's inspection refuses others).
  fs.mkdirSync(path.join(dir, 'journal'), { recursive: true, mode: 0o700 });
  const lines = [];
  for (let i = 0; i < n; i++) {
    const rec = { id: 'append-rolled-back:viewing:' + crypto.randomUUID() + ':business-rollback', kind: 'append-rolled-back', at: '2026-10-10T00:00:00.000Z', body: { eventId: crypto.randomUUID(), cause: 'business-rollback' } };
    const text = JSON.stringify(rec); lines.push(JSON.stringify({ ...rec, sha256: crypto.createHash('sha256').update(text).digest('hex') }));
  }
  // The retained fixture represents an already durable journal. Its initial
  // megabytes must not be flushed by the first measured append's fdatasync.
  const fd=fs.openSync(path.join(dir,'journal','failure-journal.jsonl'),'w');
  try{fs.writeFileSync(fd,lines.length?lines.join('\n')+'\n':'');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
async function sample(label, rep, n) {
  const make = label === 'r3' ? d => new J3.FailureJournal(d) : d => new J4.FailureJournal(d,
    new CO.StateCoordinator(d, process.platform === 'linux' ? undefined : request => EW.executeExternal(request)));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-jcost-')); fs.chmodSync(dir, 0o700);
    if (label === 'r4d') {
      // The candidate admits a journal only beside an initialized seal lineage (an unexplained journal is refused), and
      // its owner fence is released only by process death: a child process initializes the pair as the service does
      // and exits; then the retained journal fixture is seeded and the measured owner opens.
      const init = spawnSync(process.execPath, [__filename, r3, r4b, '--init', dir], { encoding: 'utf8', timeout: 60000 });
      if (init.status !== 0) throw new Error(`pair initialization failed: ${init.stderr || init.error}`);
    }
    seed(dir, n);
    try {
      const t0 = performance.now(), j = make(dir), open_ms = performance.now() - t0, times = [];
      let readBytes=0;
      const fileRead=fs.readFileSync,rangeRead=fs.readSync;
      fs.readFileSync=function(...args){const v=fileRead.apply(this,args);readBytes+=Buffer.byteLength(v);return v;};
      fs.readSync=function(...args){const n=rangeRead.apply(this,args);readBytes+=n;return n;};
      try {
        for (let i = 0; i < 20; i++) {
          const s = performance.now();
          j.record('ledger-unavailable:transaction:' + crypto.randomUUID() + ':commit-unknown', 'ledger-unavailable', { eventId: crypto.randomUUID(), cause: 'commit-unknown' });
          times.push(performance.now() - s);
          // One observed retained-prefix read already violates the IO contract.
          // Preserve that counterexample instead of repeating a known O(n)
          // regression until a timeout obscures its behavioural failure.
          if (label === 'r4d' && readBytes > 0) break;
        }
      } finally { fs.readFileSync=fileRead;fs.readSync=rangeRead; }
      times.sort((a, b) => a - b);
      const bytes = fs.statSync(path.join(dir, 'journal', 'failure-journal.jsonl')).size;
      return { version: label, rep, records: n, journal_mib: +(bytes / 1048576).toFixed(1), open_ms: +open_ms.toFixed(1), read_bytes:readBytes,
        p50:times[Math.ceil(times.length*.5)-1],p95:times[Math.ceil(times.length*.95)-1],p99:times[Math.ceil(times.length*.99)-1],samples:times };
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/* ── A11 capacity ladder ─────────────────────────────────────────────────────────────────────
 * The conservative single-hospital envelope (A11) is the REQUIREMENT. This mode drives the actual v3
 * product classes (StateCoordinator + FailureJournal + AccessSeal + ProtectedStateService; every
 * operation through service.dispatch, exactly as tests/emr/b/state_service_test.cjs wires them) over
 * that suite's memory SQL model, measures one rung, and compares the measurements with the envelope
 * numbers verbatim. Shortfalls are findings: no criterion is shrunk and no rung is silently capped.
 * A rung that cannot finish (V8 heap exhaustion, wall-clock budget, service failure) still leaves a
 * record with a non-COMPLETED outcome and exits non-zero. The rung runs in a child process so that a
 * fatal V8 abort (uncatchable in-process) still produces a HEAP_EXHAUSTED record from the last
 * progress snapshot. Settled-negative and orphan attempts use the only product paths that create
 * them: a pending reservation whose slot is taken by another attempt becomes `superseded` (orphan /
 * unresolved), and a pending reservation whose slot stays free above the frontier becomes `aborted`
 * (settled negative) in recoverAtStart; the dispatcher has no direct settle-negative operation. */
const ENVELOPE = Object.freeze({
  audit_id: 'A11', status: 'PROPOSED_REQUIREMENT_NOT_A_CAPACITY_PASS',
  proposal_sha256: 'd90c7595f8aee72e7b473a358a3e6fc22d8b698a1a23a21fb8338550c455c6b6',
  cardinality: { per_stream_lifetime_committed_events: 100000000, per_stream_lifetime_attempt_keys: 300000000,
    both_streams_lifetime_events: 200000000, both_streams_lifetime_attempt_keys: 600000000,
    viewing_retained_events: 20000000, history_retained_events: 100000000, lifetime_bundle_attestations: 100000000,
    simultaneously_unresolved_attempts_both_streams: 10000, concurrent_sessions_clients: 48 },
  mix_matrix: { committed_acked: 0.95, committed_unacked: 0.01, settled_negative: 0.03, orphan_or_unknown: 0.01 },
  throughput_and_latency: { sustained_logical_operations_per_second: 20, sustained_duration_seconds: 3600,
    dual_stream_entries_per_second: 40, burst_logical_operations_per_second: 100, concurrent_clients: 48,
    reserve_p95_ms: 100, complete_durable_receipt_p95_ms: 500, complete_durable_receipt_p99_ms: 1000, steady_unexpected_errors_allowed: 0 },
  hardware_and_storage: { cpu_logical_min: 2, ram_bytes_min: 8327843840, emr_owner_rss_ceiling_bytes: 2147483648,
    api_rss_ceiling_bytes: 1073741824, postgres_budget_bytes: 2147483648, ledger_primary_allocated_bytes: 3298534883328 },
  storage_derivation: { retained_event_count: 120000000, bytes_per_retained_event_including_sql_indexes_budget: 4096,
    attempt_key_count: 600000000, bytes_per_attempt_including_terminal_and_exact_identity_budget: 1024,
    bundle_count: 100000000, bytes_per_bundle_full_proof_budget: 2048, base_bytes: 1310720000000, working_overhead_factor: 1.5 },
  recovery_restore_and_full_disk: { warm_owner_restart_ready_seconds_max: 300, cold_validated_pair_recovery_seconds_max: 1800, acknowledged_write_loss_allowed: 0 },
  verification_contract: { minimum_events: [0, 1], existing_benchmark_event_sizes: [0, 20000, 100000],
    operational_ladder_events_per_stream: [1000000, 10000000, 100000000], operational_ladder_attempts_per_stream: [3000000, 30000000, 300000000],
    known_implementation_limit: 'resident terminal/intents/slot/proof maps and JSON whole-state cloning (external-writer.ts) cannot hold 600M attempt keys in 8 GB' },
});
const RUNG_NAMES = { minimum: 0, pristine: 0, one: 1, 'benchmark-20k': 20000, 'benchmark-100k': 100000,
  'ladder-1m': 1000000, 'ladder-10m': 10000000, 'ladder-100m': 100000000 };
const MIXES = ['acked', 'unacked', 'negative', 'orphan', 'ordinary'];
const ENVELOPE_SOURCE = process.env.A11_ENVELOPE_FILE || null;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
function ladderUsage(message) {
  process.stderr.write((message ? message + '\n' : '') + 'usage: node --max-old-space-size=3072 journal_cost.cjs --ladder --rung <name|count> ' +
    '--mix <' + MIXES.join('|') + '> --streams <one|two> --out <dir> [--budget-seconds N] [--sample-every N] [--heap-mb N] [--keep-state]\n' +
    'rung names: ' + Object.entries(RUNG_NAMES).map(([k, v]) => `${k}=${v}`).join(', ') + '\n');
  return 64;
}
function parseLadderArgs(argv) {
  const o = { rung: null, mix: 'ordinary', streams: 'two', out: null, budgetSeconds: 1800, sampleEvery: 10000, heapMb: 3072, keepState: false, child: false };
  for (let i = argv.indexOf('--ladder') + 1; i < argv.length; i++) {
    const key = argv[i], value = argv[i + 1];
    if (key === '--child') { o.child = true; continue; }
    if (key === '--keep-state') { o.keepState = true; continue; }
    if (value === undefined) throw new Error('missing value for ' + key);
    if (key === '--rung') o.rung = value in RUNG_NAMES ? RUNG_NAMES[value] : Number(value);
    else if (key === '--mix') o.mix = value;
    else if (key === '--streams') o.streams = value;
    else if (key === '--out') o.out = path.resolve(value);
    else if (key === '--budget-seconds') o.budgetSeconds = Number(value);
    else if (key === '--sample-every') o.sampleEvery = Number(value);
    else if (key === '--heap-mb') o.heapMb = Number(value);
    else throw new Error('unknown option ' + key);
    i++;
  }
  if (!Number.isSafeInteger(o.rung) || o.rung < 0) throw new Error('--rung must be a rung name or a non-negative integer');
  if (!MIXES.includes(o.mix)) throw new Error('--mix must be one of ' + MIXES.join(', '));
  if (!['one', 'two'].includes(o.streams)) throw new Error('--streams must be one or two');
  if (!o.out) throw new Error('--out <dir> is required');
  if (!(o.budgetSeconds > 0) || !(o.sampleEvery > 0) || !(o.heapMb > 0)) throw new Error('numeric options must be positive');
  o.label = `${o.rung}-${o.mix}-${o.streams}`;
  return o;
}
/** Attempt classes for one rung. The rung counts committed events per stream; the ordinary mix adds the
 * non-committed classes at the envelope fractions so that committed attempts stay ~R. Extreme mixes are
 * 100 % one class (negative/orphan rungs therefore commit nothing: that is the envelope's own extreme). */
function planMix(rung, mix) {
  const plan = { acked: 0, unacked: 0, orphan: 0, negative: 0 };
  if (mix === 'ordinary') {
    const f = ENVELOPE.mix_matrix, attempts = Math.round(rung / (f.committed_acked + f.committed_unacked));
    plan.negative = Math.round(attempts * f.settled_negative); plan.orphan = Math.round(attempts * f.orphan_or_unknown);
    plan.unacked = Math.round(attempts * f.committed_unacked); plan.acked = attempts - plan.negative - plan.orphan - plan.unacked;
  } else plan[mix] = rung;
  return plan;
}
/** Deterministic interleaving: the class furthest behind its proportional share goes next, so the mix is uniform along the stream. */
function* schedule(plan) {
  const live = ['acked', 'unacked', 'orphan'].filter(c => plan[c] > 0), remaining = { ...plan };
  const total = live.reduce((n, c) => n + plan[c], 0);
  for (let i = 0; i < total; i++) {
    let best = null, bestScore = -Infinity;
    for (const c of live) { if (!remaining[c]) continue; const score = remaining[c] / plan[c]; if (score > bestScore) { bestScore = score; best = c; } }
    remaining[best]--; yield best;
  }
}
class Samples {
  constructor() { this.a = new Float64Array(1 << 16); this.n = 0; }
  push(v) { if (this.n === this.a.length) { const b = new Float64Array(this.a.length * 2); b.set(this.a); this.a = b; } this.a[this.n++] = v; }
  stats() {
    if (!this.n) return { count: 0, p50: null, p95: null, p99: null, max: null, mean: null };
    const s = this.a.slice(0, this.n).sort(), q = p => s[Math.min(s.length - 1, Math.ceil(s.length * p) - 1)];
    let sum = 0; for (const v of s) sum += v;
    return { count: this.n, p50: +q(.5).toFixed(3), p95: +q(.95).toFixed(3), p99: +q(.99).toFixed(3), max: +s[s.length - 1].toFixed(3), mean: +(sum / s.length).toFixed(3) };
  }
  windowMean(from, to) { let sum = 0, n = 0; for (let i = Math.max(0, from); i < Math.min(this.n, to); i++) { sum += this.a[i]; n++; } return n ? sum / n : null; }
}
function directoryBytes(directory) {
  const files = {}; let total = 0;
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file, prefix + entry.name + '/');
      else if (entry.isFile()) { const size = fs.statSync(file).size; files[prefix + entry.name] = size; total += size; }
    }
  };
  if (fs.existsSync(directory)) walk(directory, '');
  return { total, files };
}
const writeJsonAtomic = (file, value) => { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(value, null, 1) + '\n'); fs.renameSync(tmp, file); };
function childLoaders() {
  const root = path.resolve(__dirname, '../../..'), load = name => require(path.join(root, 'api/src', name + '.ts'));
  return { root, ProtectedStateService: load('emr-runtime/state-service').ProtectedStateService, StateCoordinator: load('emr-runtime/coordinator').StateCoordinator,
    FailureJournal: load('emr-runtime/failure-journal').FailureJournal, AccessSeal: load('emr-runtime/seal').AccessSeal,
    executeExternal: load('emr-runtime/external-writer').executeExternal, C: load('emr-runtime/contract'), A: load('emr-contract/access-event') };
}
/** The suite's memory SQL model (same methods, same cloned return shapes) with indexed lookups so that the
 * model's own cost stays O(1)/O(log n) per call and the measured latency belongs to the product classes. */
function ladderModel() {
  const streams = Object.fromEntries(['viewing', 'history'].map(s => [s, { chainId: crypto.randomUUID(), rows: [], byEvent: new Map(), byAttempt: new Map(), bySlot: new Map() }]));
  const after = (rows, n) => { let lo = 0, hi = rows.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (rows[mid].sequence > n) hi = mid; else lo = mid + 1; } return lo; };
  const sql = {
    snapshot: async work => work(sql), withWriterFence: async work => work(sql),
    tail: async stream => { const s = streams[stream], last = s.rows[s.rows.length - 1]; return { chainId: s.chainId, sequence: last?.sequence ?? 0, hash: last?.hash ?? '0'.repeat(64) }; },
    entriesAfter: async (s, n, limit) => { const rows = streams[s].rows, i = after(rows, n); return structuredClone(rows.slice(i, i + limit)); },
    markerForSlot: async (s, n) => structuredClone(streams[s].bySlot.get(n) ?? null),
    markerForAttempt: async (s, id) => structuredClone(streams[s].byAttempt.get(id) ?? null),
    entryForEvent: async (s, id) => structuredClone(streams[s].byEvent.get(id) ?? null),
  };
  sql.verificationPage = async (s, n, count) => ({ tail: await sql.tail(s), first: (await sql.entriesAfter(s, 0, 1))[0] ?? null,
    entries: await Promise.all((await sql.entriesAfter(s, n, count)).map(async entry => ({ entry, marker: await sql.markerForSlot(s, entry.sequence) }))) });
  const commit = (stream, row, marker) => { const s = streams[stream]; s.rows.push(row); s.byEvent.set(row.eventId, row); s.byAttempt.set(marker.attemptId, marker); s.bySlot.set(marker.sequence, marker); };
  const rows = () => streams.viewing.rows.length + streams.history.rows.length;
  return { streams, sql, commit, rows };
}
function ladderEvent(A, change) {
  const known = value => ({ status: 'known', value }), uuid = crypto.randomUUID;
  return { formatVersion: 1, surface: change ? 'POST studies/:uid/report/commit' : 'GET studies/:uid/report/versions',
    eventId: uuid(), userId: known({ id: uuid(), issuer: 'https://identity.example.test', subject: 'synthetic' }),
    rolesAtTime: known(['radiologist']), actingInstitution: known('hospital-a'), managingInstitution: known('hospital-a'),
    occurredAt: '2026-10-09T00:00:00.000Z', trustedProxyIp: known({ address: '192.0.2.1', source: 'trusted-proxy' }), cause: 'user-view',
    context: { basis: 'assigned-reading', studyId: 'study-1', relatedStudyId: null, reason: null }, executor: 'member',
    targets: [{ kind: 'report-version', patientLinkSnapshot: known({ linkId: 'link-1', patientId: 'SYN-1', assigningAuthority: 'hospital-a' }),
      studyId: known('study-1'), recordId: known('report-1'), versionId: known('version-1') }],
    action: change ? 'approve-sign' : 'provide-prepared', result: change ? 'succeeded' : 'prepared', requestId: 'request-1',
    auditLinkId: A.newAuditLinkId(), relatedEventId: null };
}
/** The stored major format the ladder's owner serves (EMR_STATE_FORMAT=4: KIN-EMR-STATE-V4, V4-T12; default v3). */
const LADDER_FORMAT = process.env.EMR_STATE_FORMAT === '4' ? 4 : 3;
/** The suite's fixture() wiring without node:test; `cold` fixtures are started by the caller so startup can be timed. */
async function ladderFixture(P, directory, database) {
  const coordinator = new P.StateCoordinator(directory, P.executeExternal, { format: LADDER_FORMAT });
  const journal = new P.FailureJournal(directory, coordinator), seal = new P.AccessSeal(directory, database.sql, journal);
  const pair = { instanceId: 'synthetic-copy', chains: Object.fromEntries(Object.entries(database.streams).map(([s, v]) => [s, v.chainId])),
    database: { database: 'isolated', oid: 10001, address: '127.0.0.1', port: 5432 } };
  const service = new P.ProtectedStateService({ coordinator, journal, seal, sql: database.sql, pair, copy: null });
  const peers = [];
  const hello = async (role = 'api', clientInstanceId = crypto.randomUUID()) => {
    const socket = new (require('node:net').Socket)(); peers.push(socket);
    const request = { v: 1, requestId: crypto.randomUUID(), serviceEpoch: null, session: null, workId: null, operation: 'hello', value: { protocol: 1, clientInstanceId } };
    const reply = await service.dispatch(role, request, socket);
    if (!reply.ok) return { reply, socket, request };
    const identity = { clientInstanceId, chains: pair.chains }, session = reply.result.session;
    const req = (operation, value = {}, workId = null) => ({ v: 1, requestId: crypto.randomUUID(), serviceEpoch: service.serviceEpoch, session, workId, operation, value: { ...identity, ...value } });
    const call = (operation, value, workId) => service.dispatch(role, req(operation, value, workId), socket);
    const work = async () => {
      const workId = crypto.randomUUID(), began = await call('begin', {}, workId);
      if (!began.ok) throw new Error('begin refused: ' + JSON.stringify(began.error));
      const scope = began.result.scope;
      return { workId, scope, call: (op, value) => call(op, { scope, ...value }, workId) };
    };
    return { reply, socket, request, identity, call, req, work };
  };
  const close = async () => { service.close(); for (const socket of peers) socket.destroy(); await service.drained(); coordinator.close(); };
  return { service, coordinator, journal, seal, pair, directory, hello, close };
}
async function ladderChild(o) {
  const P = childLoaders(), { A, C } = P;
  const outFile = path.join(o.out, `ladder-${o.label}.json`), partialFile = path.join(o.out, `ladder-${o.label}-partial.json`);
  const directory = path.join(o.out, `state-${o.label}`);
  fs.rmSync(directory, { recursive: true, force: true }); fs.mkdirSync(directory, { recursive: true }); fs.chmodSync(directory, 0o700);
  const plan = planMix(o.rung, o.mix), twoStreams = o.streams === 'two', streamList = twoStreams ? ['viewing', 'history'] : ['viewing'];
  const v8 = require('node:v8'), t0 = performance.now(), budgetMs = o.budgetSeconds * 1000;
  const record = {
    tool: 'tests/emr/b/journal_cost.cjs --ladder', started_at: new Date().toISOString(), pid: process.pid,
    envelope: ENVELOPE, envelope_source_file: ENVELOPE_SOURCE, envelope_source_file_sha256_observed: ENVELOPE_SOURCE && fs.existsSync(ENVELOPE_SOURCE) ? sha256(fs.readFileSync(ENVELOPE_SOURCE)) : null,
    host: { platform: process.platform, release: os.release(), arch: process.arch, node: process.version, logical_cpus: os.cpus().length,
      total_memory_bytes: os.totalmem(), free_memory_bytes_at_start: os.freemem(), v8_heap_size_limit_bytes: v8.getHeapStatistics().heap_size_limit, exec_argv: process.execArgv },
    options: { rung_events_per_stream: o.rung, mix: o.mix, streams: o.streams, stream_list: streamList, budget_seconds: o.budgetSeconds, sample_every_ops: o.sampleEvery, state_directory: directory, state_format: LADDER_FORMAT },
    plan, method: {
      operations: 'reserve (per stream) -> model COMMIT -> confirm-bundle -> acknowledge (acked class only); orphan = reservation superseded by the next attempt on the same slot (product: terminal.superseded + commit-not-found journal); ' +
        'negative = reservations at free slots above the final frontier, settled aborted by recoverAtStart in the cold-recovery phase (product: terminal.aborted). The dispatcher has no settle-negative operation.',
      latency: 'performance.now() around each service.dispatch call; receipt = confirm-bundle',
      memory: 'process.memoryUsage() at baseline (after start, before load), every sample_every_ops operations, after load, after close, after cold recovery; global.gc() before phase samples when exposed. The same process holds the memory SQL model and the harness: see model_estimate_bytes.',
      clone: "coordinator.call('read') timed three times; JSON.stringify byte length of the returned whole state (known implementation limit)",
      files: 'byte sizes of the state directory in steady state, after a forced coordinator compaction (public coordinator operation, as the suite uses) and after cold recovery',
      recovery: 'service.close + drained + coordinator.close, then a new fixture over the same directory and model; time until service.start() resolves (AccessSeal.recoverAtStart)',
      extrapolation: 'linear per-key / per-event slopes from this rung to the envelope maxima; NOT measurements',
    },
    outcome: 'RUNNING', counts: { attempts_created: 0, attempt_keys_created: 0, reserves: 0, committed_events: 0, committed_rows: 0, bundles_published: 0, acks: 0,
      acked: 0, unacked: 0, orphan: 0, negative: 0, orphan_pending_at_end: 0, max_simultaneously_unresolved: 0, unexpected_errors: 0, operations: 0 },
    errors: [], memory_samples: [], memory: {}, latency_ms: {}, timings_ms: {}, state_clone: null, files: {}, cold_recovery: null, derived: null, extrapolated: null, verdict: null, not_measured: null,
  };
  const reserveSamples = new Samples(), receiptSamples = new Samples(), ackSamples = new Samples();
  const gc = () => { if (global.gc) global.gc(); };
  const peak = { rss: 0, heapUsed: 0 };
  const sampleMemory = phase => {
    const m = process.memoryUsage(); peak.rss = Math.max(peak.rss, m.rss); peak.heapUsed = Math.max(peak.heapUsed, m.heapUsed);
    const row = { phase, operations: record.counts.operations, at_ms: +(performance.now() - t0).toFixed(0), rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external, arrayBuffers: m.arrayBuffers };
    record.memory_samples.push(row); return row;
  };
  const finish = () => {
    record.memory.peak = { ...peak }; record.latency_ms = { reserve: reserveSamples.stats(), receipt_confirm_bundle: receiptSamples.stats(), acknowledge: ackSamples.stats() };
    record.timings_ms.total = +(performance.now() - t0).toFixed(0); record.finished_at = new Date().toISOString();
    const n = receiptSamples.n, w = Math.max(1, Math.floor(n / 10));
    record._receiptWindow = n >= 20 ? { first: receiptSamples.windowMean(0, w), last: receiptSamples.windowMean(n - w, n) } : null;
  };
  const writePartial = () => { finish(); writeJsonAtomic(partialFile, record); };
  let modelPayloadBytes = 0;
  const samplesKept = {};
  const database = ladderModel();
  const elapsed = () => performance.now() - t0, overBudget = () => elapsed() > budgetMs;
  const fail = (phase, reply) => {
    record.counts.unexpected_errors++;
    if (record.errors.length < 20) record.errors.push({ phase, at_operation: record.counts.operations, error: reply?.error ?? String(reply) });
  };
  const timed = async (bucket, fn) => { const s = performance.now(); let reply; try { reply = await fn(); } catch (error) { reply = { ok: false, error: { code: error.code ?? 'THROWN', message: String(error.message ?? error) } }; } bucket.push(performance.now() - s); record.counts.operations++; return reply; };
  let lastProgressAt = performance.now();
  const progress = (force = false) => {
    // Per-operation cadence plus a 60 s cadence: a slow rung must still leave a recent partial record.
    if (!force && record.counts.operations % o.sampleEvery !== 0 && performance.now() - lastProgressAt < 60000) return;
    lastProgressAt = performance.now();
    sampleMemory('load'); writePartial();
    process.stderr.write(`ladder ${o.label}: ops=${record.counts.operations} attempts=${record.counts.attempts_created} committed=${record.counts.committed_events} rss=${(peak.rss / 1048576).toFixed(0)}MiB elapsed=${(elapsed() / 1000).toFixed(0)}s\n`);
  };
  let f = null;
  try {
    f = await ladderFixture(P, directory, database);
    const s0 = performance.now(); await f.service.start(); record.timings_ms.initial_start = +(performance.now() - s0).toFixed(1);
    gc(); record.memory.baseline = sampleMemory('baseline');
    const peer = await f.hello(); if (!peer.reply.ok) throw new Error('hello refused: ' + JSON.stringify(peer.reply.error));
    const work = await peer.work();
    const reserveEvent = async input => {
      const attemptId = crypto.randomUUID(), bundleId = crypto.randomUUID(), bindings = [], rows = [];
      for (const stream of A.accessStreams(input)) {
        const canonical = C.canonicalPayload(input, undefined, stream), tail = await database.sql.tail(stream);
        const binding = { stream, chainId: tail.chainId, attemptId, bundleId, kind: stream === 'viewing' ? 'access' : 'history',
          eventId: input.eventId, sequence: tail.sequence + 1, previousHash: tail.hash,
          hash: C.entryHash(tail.sequence + 1, tail.hash, canonical.text), contentSha256: canonical.contentSha256 };
        const reply = await timed(reserveSamples, () => work.call('reserve', { binding, prefix: null }));
        record.counts.reserves++;
        if (!reply.ok) return { ok: false, reply, stream, partial: bindings };
        bindings.push(reply.result); rows.push({ sequence: binding.sequence, previousHash: binding.previousHash,
          hash: binding.hash, kind: binding.kind, statutoryAct: A.statutoryAct(input), eventId: input.eventId,
          payload: canonical.text, contentSha256: canonical.contentSha256, storedAt: '2026-10-19T00:00:00.000Z' });
      }
      const bundle = { eventId: input.eventId, requiredStreams: [...A.accessStreams(input)], bindings };
      const commit = () => { bindings.forEach((b, i) => database.commit(b.stream, rows[i], b)); modelPayloadBytes += rows.reduce((n, r) => n + r.payload.length, 0); };
      return { ok: true, bundle, commit };
    };
    const loadStart = performance.now();
    let orphanPending = null;
    for (const cls of schedule(plan)) {
      if (overBudget()) { record.outcome = 'TIME_BUDGET_EXHAUSTED'; break; }
      if (f.service.state !== 'ready') { record.outcome = 'SERVICE_FAILED'; break; }
      const item = await reserveEvent(ladderEvent(A, twoStreams));
      record.counts.attempts_created++; record.counts.attempt_keys_created += item.ok ? item.bundle.bindings.length : item.partial.length;
      if (!item.ok) { fail('reserve', item.reply); progress(); continue; }
      if (cls === 'orphan') { record.counts.orphan++; orphanPending = item; samplesKept.orphan ??= item.bundle; progress(); continue; }
      orphanPending = null;
      item.commit(); record.counts.committed_events++; record.counts.committed_rows += item.bundle.bindings.length;
      const proof = await timed(receiptSamples, () => work.call('confirm-bundle', item.bundle));
      if (!proof.ok) { fail('confirm-bundle', proof); progress(); continue; }
      record.counts.bundles_published++;
      if (cls === 'acked') {
        const ack = await timed(ackSamples, () => work.call('acknowledge', { proof: proof.result, bindings: item.bundle.bindings }));
        if (!ack.ok) fail('acknowledge', ack); else { record.counts.acks++; record.counts.acked++; samplesKept.acked ??= { bundle: item.bundle, proof: proof.result }; }
      } else { record.counts.unacked++; samplesKept.unacked ??= { bundle: item.bundle, proof: proof.result }; }
      progress();
    }
    record.counts.orphan_pending_at_end = orphanPending ? 1 : 0;
    record.timings_ms.load_loop = +(performance.now() - loadStart).toFixed(0);
    // Settled-negative attempts can only be created above the final frontier, so they follow the loop. When the
    // budget cut the loop short, reserve the progress-proportional share under a 10 % extra allowance so that
    // the cold-recovery phase still settles `aborted` terminals; the shortfall stays visible in counts/plan.
    const loopPlanned = plan.acked + plan.unacked + plan.orphan, loopDone = record.counts.attempts_created;
    const negativeShare = record.outcome === 'RUNNING' || !loopPlanned ? plan.negative : Math.round(plan.negative * loopDone / loopPlanned);
    record.counts.negative_planned_after_loop = negativeShare;
    if (negativeShare > 0) {
      const negStart = performance.now(), tails = {}, negativeDeadline = Math.max(budgetMs, elapsed()) + budgetMs * 0.1;
      for (const stream of streamList) tails[stream] = await database.sql.tail(stream);
      for (let k = 1; k <= negativeShare; k++) {
        if (elapsed() > negativeDeadline) { record.outcome = 'TIME_BUDGET_EXHAUSTED'; break; }
        if (f.service.state !== 'ready') { record.outcome = 'SERVICE_FAILED'; break; }
        const attemptId = crypto.randomUUID(), bundleId = crypto.randomUUID(), eventId = crypto.randomUUID(), bindings = [];
        let ok = true;
        for (const stream of streamList) {
          // Slot tail+1 stays free for a possible pending orphan; k>=1 lands above it. Synthetic
          // hashes: a reservation whose COMMIT never happens (D1641-T06 pattern).
          const sequence = tails[stream].sequence + 1 + k;
          const binding = { stream, chainId: tails[stream].chainId, attemptId, bundleId, kind: stream === 'viewing' ? 'access' : 'history', eventId, sequence,
            previousHash: sha256(`negative:${stream}:${k}:previous`), hash: sha256(`negative:${stream}:${k}:hash`), contentSha256: sha256(`negative:${stream}:${k}:content`) };
          const reply = await timed(reserveSamples, () => work.call('reserve', { binding, prefix: null }));
          record.counts.reserves++; record.counts.attempt_keys_created++;
          if (!reply.ok) { fail('reserve-negative', reply); ok = false; break; }
          bindings.push(reply.result);
        }
        record.counts.attempts_created++;
        if (ok) { record.counts.negative++; samplesKept.negative ??= { eventId, requiredStreams: [...streamList], bindings }; }
        progress();
      }
      record.timings_ms.negative_reservations = +(performance.now() - negStart).toFixed(0);
    }
    record.counts.max_simultaneously_unresolved = record.counts.negative * streamList.length + record.counts.orphan_pending_at_end * streamList.length;
    if (record.outcome === 'RUNNING') record.outcome = 'COMPLETED';
    progress(true);
    // Steady-state measurements (also on a partial load: the slope is the finding).
    gc(); record.memory.after_load = sampleMemory('after-load');
    const cloneOnce = () => { const s = performance.now(); const state = f.coordinator.call('read'); const read_ms = performance.now() - s; return { state, read_ms }; };
    const clones = [cloneOnce(), cloneOnce(), cloneOnce()], state = clones[2].state;
    const c0 = performance.now(), json = JSON.stringify(state), stringify_ms = performance.now() - c0;
    record.state_clone = { read_ms: clones.map(c => +c.read_ms.toFixed(2)), stringify_ms: +stringify_ms.toFixed(2), json_bytes: Buffer.byteLength(json),
      revision: state.revision, generation: state.generation, terminal: Object.keys(state.terminal).length, intents: Object.keys(state.intents).length,
      slots: Object.keys(state.slots).length, proofs: Object.keys(state.proofs).length, bundles: Object.keys(state.bundles).length,
      bundles_json_bytes: Buffer.byteLength(JSON.stringify(state.bundles)), terminal_json_bytes: Buffer.byteLength(JSON.stringify(state.terminal)),
      acknowledged_bundles: Object.values(state.bundles).filter(b => b.phase === 'acknowledged').length,
      terminal_phases: Object.values(state.terminal).reduce((acc, t) => { acc[t.phase] = (acc[t.phase] ?? 0) + 1; return acc; }, {}) };
    record.files.steady = directoryBytes(directory);
    if (LADDER_FORMAT === 4) { try { record.v4_status_after_load = f.coordinator.call('v4-status'); } catch (error) { record.v4_status_after_load = { error: error.code ?? String(error) }; } }
    const k0 = performance.now(); let compactError = null;
    try { f.coordinator.call('compact', { force: true }); } catch (error) { compactError = error.code ?? String(error); }
    record.timings_ms.forced_compaction = +(performance.now() - k0).toFixed(1); record.files.after_forced_compaction = { ...directoryBytes(directory), error: compactError };
    record.counts.journal_records_before_recovery = f.journal.all().length;
    writePartial();
    // Cold recovery over the same directory and model, through the same construction as the suite.
    const x0 = performance.now(); await f.close(); record.timings_ms.close = +(performance.now() - x0).toFixed(1);
    f = null; gc(); record.memory.after_close = sampleMemory('after-close');
    const g = await ladderFixture(P, directory, database);
    const r0 = performance.now(); let recoveryError = null;
    try { await g.service.start(); } catch (error) { recoveryError = { code: error.code ?? null, message: String(error.message ?? error) }; }
    const start_ms = performance.now() - r0;
    record.cold_recovery = { start_ms: +start_ms.toFixed(1), service_state: g.service.state, error: recoveryError, journal_records_after: g.journal.all().length, checks: [] };
    record.files.after_recovery = directoryBytes(directory);
    if (LADDER_FORMAT === 4 && g.service.state === 'ready') { try { record.cold_recovery.v4_status = g.coordinator.call('v4-status'); } catch (error) { record.cold_recovery.v4_status = { error: error.code ?? String(error) }; } }
    gc(); record.memory.after_recovery = sampleMemory('after-recovery');
    if (g.service.state === 'ready') {
      const rs = performance.now(); const recovered = g.coordinator.call('read'); record.cold_recovery.read_ms_after = +(performance.now() - rs).toFixed(2);
      record.cold_recovery.terminal_phases = Object.values(recovered.terminal).reduce((acc, t) => { acc[t.phase] = (acc[t.phase] ?? 0) + 1; return acc; }, {});
      record.cold_recovery.intents_after = Object.keys(recovered.intents).length;
      const gp = await g.hello(), gw = await gp.work();
      const expect = { acked: 'committed-and-sealed', unacked: 'committed-and-sealed', negative: 'fenced-not-committed', orphan: 'unresolved' };
      for (const [cls, kept] of Object.entries(samplesKept)) {
        const bundle = kept.bundle ?? kept, lookup = await gw.call('lookup-outcome', bundle);
        const check = { class: cls, expected: expect[cls], outcome: lookup.ok ? lookup.result.outcome : lookup.error };
        if (kept.proof && lookup.ok) check.proof_identical = JSON.stringify(lookup.result.proof) === JSON.stringify(kept.proof);
        const { generation, proofDigest, ...binding } = bundle.bindings[0];
        const replay = await gw.call('reserve', { binding, prefix: null });
        check.replay_reserve = replay.ok ? 'ACCEPTED' : replay.error.code; check.replay_expected = cls === 'orphan' ? 'CONFLICT (superseded) or ACCEPTED only if slot still pending' : 'CONFLICT';
        if (cls === 'acked') { const ack = await gw.call('acknowledge', { proof: kept.proof, bindings: bundle.bindings }); check.ack_retry = ack.ok ? ack.result.status : ack.error; }
        record.cold_recovery.checks.push(check);
      }
    }
    await g.close();
  } catch (error) {
    const text = String(error?.stack ?? error);
    record.outcome = /heap out of memory|Allocation failed|Invalid array length|Array buffer allocation failed|ERR_STRING_TOO_LONG|Invalid string length/i.test(text) ? 'HEAP_EXHAUSTED' : 'TOOL_ERROR';
    record.tool_error = text.slice(0, 4000);
    try { if (f) await f.close(); } catch { /* the record is the result */ }
  }
  finish();
  record.model_estimate_bytes = { payload_bytes: modelPayloadBytes, rows: database.rows(), estimate: modelPayloadBytes + database.rows() * 1200,
    note: 'memory SQL model held by this same process: payload text (one byte per ASCII char in V8) + ~1200 B/row for row object, marker binding and three index entries; an estimate, not a measurement' };
  deriveAndJudge(record, streamList.length);
  writeJsonAtomic(outFile, record);
  fs.rmSync(partialFile, { force: true });
  if (!o.keepState) fs.rmSync(directory, { recursive: true, force: true });
  return record.outcome === 'COMPLETED' ? 0 : 2;
}
function deriveAndJudge(record, streamCount) {
  const E = ENVELOPE, c = record.counts, clone = record.state_clone, m = record.memory;
  const div = (a, b) => a == null || !b ? null : a / b;
  const keys = clone ? clone.terminal + clone.intents : null;
  const rows = c.committed_rows, bundles = clone ? clone.bundles : null;
  const heapDelta = m.after_load && m.baseline ? m.after_load.heapUsed - m.baseline.heapUsed : null;
  const rssDelta = m.after_load && m.baseline ? m.after_load.rss - m.baseline.rss : null;
  const productHeap = heapDelta == null ? null : Math.max(0, heapDelta - record.model_estimate_bytes.estimate);
  // The checkpoint bytes per key: the v3 checkpoint file, or the v4 root's pages, roots and WAL (seal/v4/, less scratch).
  const v4Bytes = files => files ? Object.entries(files).filter(([name]) => name.startsWith('seal/v4/') && !name.startsWith('seal/v4/tmp/')).reduce((n, [, size]) => n + size, 0) : null;
  const steadyTotal = record.files.steady?.total ?? null;
  const compactedCheckpoint = LADDER_FORMAT === 4 ? v4Bytes(record.files.after_forced_compaction?.files) : record.files.after_forced_compaction?.files?.['seal/settlement.json'] ?? null;
  const per = {
    heap_bytes_per_attempt_key_total: div(heapDelta, keys), heap_bytes_per_attempt_key_product_estimate: div(productHeap, keys),
    rss_bytes_per_attempt_key_total: div(rssDelta, keys), state_json_bytes_per_attempt_key: div(clone?.json_bytes, keys),
    checkpoint_file_bytes_per_attempt_key: div(compactedCheckpoint, keys), state_files_bytes_per_retained_row_steady: div(steadyTotal, rows),
    state_files_bytes_per_retained_row_compacted: div(record.files.after_forced_compaction?.total, rows),
    bundle_state_json_bytes_per_bundle: div(clone?.bundles_json_bytes, bundles), terminal_state_json_bytes_per_key: div(clone?.terminal_json_bytes, keys),
    clone_read_ms_per_attempt_key: div(clone ? Math.min(...clone.read_ms) : null, keys), cold_recovery_ms_per_attempt_key: div(record.cold_recovery?.start_ms, keys),
    cold_recovery_ms_per_retained_row: div(record.cold_recovery?.start_ms, rows),
  };
  // Per-operation cost growth: mean receipt latency in the first and last 10 % windows against the keys present then.
  const r = record.latency_ms.receipt_confirm_bundle, n = r?.count ?? 0;
  let slope = null;
  if (n >= 20 && keys) {
    const w = Math.max(1, Math.floor(n / 10)), keysPerBundle = keys / n;
    const first = record._receiptWindow?.first ?? null, last = record._receiptWindow?.last ?? null;
    if (first != null && last != null) slope = { receipt_ms_first_window: +first.toFixed(3), receipt_ms_last_window: +last.toFixed(3), keys_first_window_mid: w / 2 * keysPerBundle, keys_last_window_mid: (n - w / 2) * keysPerBundle,
      ms_per_bundle_per_key: (last - first) / ((n - w) * keysPerBundle) };
  }
  record.derived = { attempt_keys_in_state: keys, committed_rows: rows, bundles_in_state: bundles, heap_delta_bytes: heapDelta, rss_delta_bytes: rssDelta,
    product_heap_delta_estimate_bytes: productHeap, ...per, receipt_cost_growth: slope };
  const K = E.cardinality.both_streams_lifetime_attempt_keys, R = E.storage_derivation.retained_event_count, B = E.storage_derivation.bundle_count;
  const lin = (perUnit, units) => perUnit == null ? null : Math.round(perUnit * units);
  record.extrapolated = {
    basis: `linear extrapolation from this rung (${keys ?? 0} attempt keys, ${rows} retained rows, ${bundles ?? 0} bundles) to ${K} attempt keys / ${R} retained events / ${B} bundles; NOT measured`,
    extrapolated_rss_bytes: m.baseline ? lin(per.rss_bytes_per_attempt_key_total, K) == null ? null : m.baseline.rss + lin(per.rss_bytes_per_attempt_key_total, K) : null,
    extrapolated_heap_bytes_total: lin(per.heap_bytes_per_attempt_key_total, K), extrapolated_heap_bytes_product_estimate: lin(per.heap_bytes_per_attempt_key_product_estimate, K),
    extrapolated_state_clone_json_bytes: lin(per.state_json_bytes_per_attempt_key, K), extrapolated_checkpoint_file_bytes: lin(per.checkpoint_file_bytes_per_attempt_key, K),
    extrapolated_state_files_bytes_at_retained_events: lin(per.state_files_bytes_per_retained_row_compacted, R),
    extrapolated_bundle_state_json_bytes: lin(per.bundle_state_json_bytes_per_bundle, B),
    extrapolated_clone_read_ms: lin(per.clone_read_ms_per_attempt_key, K), extrapolated_cold_recovery_ms: lin(per.cold_recovery_ms_per_attempt_key, K),
    extrapolated_receipt_ms_at_envelope_keys: slope ? +(slope.receipt_ms_first_window + slope.ms_per_bundle_per_key * K).toFixed(1) : null,
    rungs_not_measured: ['10M events/stream (30M attempts)', '100M events/stream (300M attempts)', '600M attempt keys both streams'],
  };
  const GiB2 = E.hardware_and_storage.emr_owner_rss_ceiling_bytes, T = E.throughput_and_latency, S = E.storage_derivation;
  const check = (criterion, limit, measured, note = null, cmp = '<=') => ({ criterion, limit, measured: measured == null ? null : +(+measured).toFixed(3),
    result: measured == null ? 'UNMEASURED' : (cmp === '<=' ? measured <= limit : measured === limit) ? 'PASS' : 'FAIL', ...(note ? { note } : {}) });
  const planned = Object.values(record.plan).reduce((a, b) => a + b, 0);
  record.verdict = [
    { criterion: 'rung executed in full (all planned attempts within the wall-clock budget and heap)', limit: planned, measured: c.attempts_created, result: record.outcome === 'COMPLETED' ? 'PASS' : 'FAIL', note: 'outcome ' + record.outcome },
    check('reserve p95 ms', T.reserve_p95_ms, record.latency_ms.reserve?.p95),
    check('complete durable receipt (confirm-bundle) p95 ms', T.complete_durable_receipt_p95_ms, record.latency_ms.receipt_confirm_bundle?.p95),
    check('complete durable receipt (confirm-bundle) p99 ms', T.complete_durable_receipt_p99_ms, record.latency_ms.receipt_confirm_bundle?.p99),
    check('steady unexpected errors', T.steady_unexpected_errors_allowed, c.unexpected_errors, null, '=='),
    check('EMR owner RSS ceiling bytes (peak of this process, incl. memory SQL model and harness)', GiB2, m.peak?.rss || null),
    check('EMR owner RSS ceiling bytes at 600M attempt keys (linear extrapolation of the RSS delta)', GiB2, record.extrapolated.extrapolated_rss_bytes, 'extrapolated, not measured; RSS delta is GC-noisy at small rungs'),
    check('EMR owner RSS ceiling bytes at 600M attempt keys (linear extrapolation of the product heap estimate + baseline RSS)', GiB2,
      record.extrapolated.extrapolated_heap_bytes_product_estimate == null || !m.baseline ? null : m.baseline.rss + record.extrapolated.extrapolated_heap_bytes_product_estimate, 'extrapolated, not measured; heapUsed delta minus the memory SQL model estimate'),
    check('bytes per attempt key incl. terminal and exact identity (compacted checkpoint file)', S.bytes_per_attempt_including_terminal_and_exact_identity_budget, per.checkpoint_file_bytes_per_attempt_key, 'protected-state checkpoint only; SQL marker rows excluded'),
    check('bytes per retained event incl. SQL indexes (protected-state files per committed row)', S.bytes_per_retained_event_including_sql_indexes_budget, per.state_files_bytes_per_retained_row_compacted, 'PARTIAL: protected-state files only; SQL rows/indexes are not in this model'),
    check('bytes per bundle full proof (bundle attestation JSON in state)', S.bytes_per_bundle_full_proof_budget, per.bundle_state_json_bytes_per_bundle, 'attestation refs only; binding fields live once in terminals'),
    check('cold validated pair recovery seconds', E.recovery_restore_and_full_disk.cold_validated_pair_recovery_seconds_max, record.cold_recovery ? record.cold_recovery.start_ms / 1000 : null, 'memory SQL model, this rung only'),
    check('cold recovery seconds at 600M attempt keys (linear extrapolation)', E.recovery_restore_and_full_disk.cold_validated_pair_recovery_seconds_max, record.extrapolated.extrapolated_cold_recovery_ms == null ? null : record.extrapolated.extrapolated_cold_recovery_ms / 1000, 'extrapolated, not measured'),
    check('simultaneously unresolved attempts (tool load, informational)', E.cardinality.simultaneously_unresolved_attempts_both_streams, c.max_simultaneously_unresolved),
    { criterion: 'cold recovery settles the sample classes as expected', limit: 'acked/unacked committed-and-sealed, negative fenced-not-committed, orphan unresolved', measured: record.cold_recovery?.checks ?? null,
      result: !record.cold_recovery ? 'UNMEASURED' : record.cold_recovery.service_state !== 'ready' ? 'FAIL' : record.cold_recovery.checks.every(k => k.outcome === k.expected) ? 'PASS' : 'FAIL' },
  ];
  record.not_measured = ['operational ladder 10M and 100M events per stream', '600M attempt keys', 'real PostgreSQL topology (memory SQL model here)', 'CPU and physical read/write/fsync counts', '24/48 concurrent clients (one client, one scope)'];
  delete record._receiptWindow;
}
function ladderSummary(record, file) {
  const d = record.derived ?? {}, x = record.extrapolated ?? {}, l = record.latency_ms ?? {};
  const pick = s => s ? { p50: s.p50, p95: s.p95, p99: s.p99, n: s.count } : null;
  return { file, rung: record.options?.rung_events_per_stream, mix: record.options?.mix, streams: record.options?.streams, outcome: record.outcome, counts: record.counts,
    latency_ms: { reserve: pick(l.reserve), receipt: pick(l.receipt_confirm_bundle), acknowledge: pick(l.acknowledge) },
    memory: { baseline_rss: record.memory?.baseline?.rss ?? null, peak_rss: record.memory?.peak?.rss ?? null, heap_delta: d.heap_delta_bytes ?? null },
    clone: record.state_clone ? { read_ms: record.state_clone.read_ms, json_bytes: record.state_clone.json_bytes, keys: d.attempt_keys_in_state } : null,
    files: { steady: record.files?.steady?.total ?? null, compacted: record.files?.after_forced_compaction?.total ?? null, after_recovery: record.files?.after_recovery?.total ?? null },
    cold_recovery_ms: record.cold_recovery?.start_ms ?? null,
    per_key: { heap_total: d.heap_bytes_per_attempt_key_total, heap_product_est: d.heap_bytes_per_attempt_key_product_estimate, state_json: d.state_json_bytes_per_attempt_key, checkpoint_file: d.checkpoint_file_bytes_per_attempt_key, files_per_row: d.state_files_bytes_per_retained_row_compacted, bundle_json: d.bundle_state_json_bytes_per_bundle },
    extrapolated: { rss_bytes: x.extrapolated_rss_bytes, state_clone_json_bytes: x.extrapolated_state_clone_json_bytes, checkpoint_file_bytes: x.extrapolated_checkpoint_file_bytes, clone_read_ms: x.extrapolated_clone_read_ms, cold_recovery_ms: x.extrapolated_cold_recovery_ms, receipt_ms_at_envelope: x.extrapolated_receipt_ms_at_envelope_keys },
    verdict_fail: (record.verdict ?? []).filter(v => v.result === 'FAIL').map(v => v.criterion), verdict_unmeasured: (record.verdict ?? []).filter(v => v.result === 'UNMEASURED').map(v => v.criterion),
    tool_error: record.tool_error ? record.tool_error.split('\n')[0] : undefined };
}
async function ladderMain() {
  let o;
  try { o = parseLadderArgs(process.argv); } catch (error) { return ladderUsage(error.message); }
  if (o.child) return ladderChild(o);
  fs.mkdirSync(o.out, { recursive: true });
  const outFile = path.join(o.out, `ladder-${o.label}.json`), partialFile = path.join(o.out, `ladder-${o.label}-partial.json`);
  fs.rmSync(outFile, { force: true }); fs.rmSync(partialFile, { force: true });
  const args = [`--max-old-space-size=${o.heapMb}`, '--expose-gc', __filename, '--ladder', '--child', '--rung', String(o.rung), '--mix', o.mix, '--streams', o.streams,
    '--out', o.out, '--budget-seconds', String(o.budgetSeconds), '--sample-every', String(o.sampleEvery), '--heap-mb', String(o.heapMb), ...(o.keepState ? ['--keep-state'] : [])];
  const stderrTail = []; let tailBytes = 0;
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'inherit', 'pipe'], env: process.env });
  child.stderr.on('data', chunk => { process.stderr.write(chunk); stderrTail.push(chunk); tailBytes += chunk.length; while (tailBytes > 65536 && stderrTail.length > 1) tailBytes -= stderrTail.shift().length; });
  const exit = await new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })));
  let record = null;
  try { record = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch { record = null; }
  if (!record) {
    const stderr = Buffer.concat(stderrTail).toString('utf8');
    let partial = null; try { partial = JSON.parse(fs.readFileSync(partialFile, 'utf8')); } catch { partial = null; }
    record = partial ?? { tool: 'tests/emr/b/journal_cost.cjs --ladder', envelope: ENVELOPE, options: { rung_events_per_stream: o.rung, mix: o.mix, streams: o.streams }, plan: planMix(o.rung, o.mix), counts: {}, memory_samples: [], memory: {} };
    record.outcome = /heap out of memory|Allocation failed|OOM|Fatal process out of memory/i.test(stderr) ? 'HEAP_EXHAUSTED' : 'CHILD_CRASHED';
    record.child_exit = { code: exit.code, signal: exit.signal, stderr_tail: stderr.slice(-8000) };
    record.last_memory_sample = record.memory_samples?.[record.memory_samples.length - 1] ?? null;
    record.finished_at = new Date().toISOString();
    writeJsonAtomic(outFile, record); fs.rmSync(partialFile, { force: true });
  }
  process.stdout.write('CAPACITY_LADDER ' + JSON.stringify(ladderSummary(record, outFile)) + '\n');
  return record.outcome === 'COMPLETED' ? 0 : 2;
}
/* ── D1683 early milestone: same-v3 recovery feasibility probe ─────────────────────────────────────────
 * node --max-old-space-size=3072 journal_cost.cjs --recovery-probe --keys <terminals per stream> --out <dir>
 *   [--bundles <count, default = keys>] [--directory-every N] [--phases read,hash,lookup,merge,navigate] [--keep]
 * Writes a navigable sorted v3 checkpoint through the product's writeNavigableCheckpoint (two streams of committed
 * terminals, two-stream bundles 95 % acknowledged / 5 % published, realistic field widths), then measures each
 * recovery ingredient as the product's scanCheckpoint performs it, and extrapolates linearly to the A11 maxima
 * (600M attempt keys = 300M terminals per stream, 100M bundles) against the warm 300 s / cold 1800 s budgets.
 * Cache-warm, this host; every number is labelled as such. Nothing here is acceptance. */
function parseProbeArgs(argv) {
  const o = { keys: null, bundles: null, out: null, directoryEvery: 4096, phases: ['read', 'hash', 'lookup', 'merge', 'navigate'], keep: false };
  for (let i = argv.indexOf('--recovery-probe') + 1; i < argv.length; i++) {
    const key = argv[i], value = argv[i + 1];
    if (key === '--keep') { o.keep = true; continue; }
    if (value === undefined) throw new Error('missing value for ' + key);
    if (key === '--keys') o.keys = Number(value);
    else if (key === '--bundles') o.bundles = Number(value);
    else if (key === '--out') o.out = path.resolve(value);
    else if (key === '--directory-every') o.directoryEvery = Number(value);
    else if (key === '--phases') o.phases = value.split(',');
    else throw new Error('unknown option ' + key);
    i++;
  }
  if (!Number.isSafeInteger(o.keys) || o.keys < 1) throw new Error('--keys must be a positive integer');
  if (o.bundles === null) o.bundles = o.keys;
  if (!o.out) throw new Error('--out <dir> is required');
  return o;
}
async function recoveryProbe() {
  const o = parseProbeArgs(process.argv);
  const root = path.resolve(__dirname, '../../..'), EW2 = require(path.join(root, 'api/src/emr-runtime/external-writer.ts'));
  fs.mkdirSync(path.join(o.out, 'seal'), { recursive: true, mode: 0o700 });
  const file = path.join(o.out, 'seal', 'settlement.json');
  const uuidAt = (prefix, i) => `${prefix}-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
  const chains = { viewing: uuidAt('7c1f3a52', 1), history: uuidAt('7c1f3a52', 2) };
  const hex = (seed, i) => crypto.createHash('sha256').update(seed + ':' + i).digest('hex');
  const N = o.keys, B = Math.min(o.bundles, N), generation = 2 * N + 1, serviceEpoch = uuidAt('5e51c000', 7);
  const tail = { streams: { viewing: { chainId: chains.viewing, sequence: N, hash: hex('v', N) }, history: { chainId: chains.history, sequence: N, hash: hex('h', N) } },
    sealedAt: '2026-10-22T00:00:00.000Z', generation };
  const head = { version: 3, revision: 1, generation, tail, lineage: { version: 1, id: uuidAt('11aa0000', 9), origin: { instanceId: 'recovery-probe-synthetic-pair',
    chains, database: { database: 'synthetic', oid: 42, address: '127.0.0.1', port: 5432 } } }, retired: { viewing: 0, history: 0 }, intents: {}, slots: {}, proofs: {} };
  const binding = (stream, i) => ({ stream, chainId: chains[stream], attemptId: uuidAt(stream === 'viewing' ? 'a0000000' : 'a1000000', i), bundleId: uuidAt('b0000000', i),
    kind: stream === 'viewing' ? 'access' : 'history', eventId: uuidAt('e0000000', i), sequence: i, previousHash: hex(stream[0], i - 1), hash: hex(stream[0], i),
    contentSha256: hex('c' + stream[0], i), generation: stream === 'viewing' ? 2 * i - 1 : 2 * i, proofDigest: null });
  const proofHash = i => {
    const entries = ['viewing', 'history'].map(s => { const b = binding(s, i); return { ...b, sealed: { chainId: b.chainId, sequence: b.sequence, hash: b.hash } }; });
    return sha256(JSON.stringify({ v: 1, serviceEpoch, eventId: uuidAt('e0000000', i), requiredStreams: ['viewing', 'history'], entries }));
  };
  function* terminals() {
    for (const stream of ['history', 'viewing']) for (let i = 1; i <= N; i++) {
      const b = binding(stream, i), acked = i % 20 !== 0 && i <= B;
      yield [stream + ':' + b.attemptId, JSON.stringify({ phase: 'committed', generation: b.generation, binding: b, ...(acked ? {} : { owner: uuidAt('0c000000', 1) }) })];
    }
  }
  function* bundles() {
    for (let i = 1; i <= B; i++) {
      const refs = ['viewing', 'history'].map(s => { const b = binding(s, i); return { stream: s, attemptId: b.attemptId, sealed: { sequence: b.sequence, hash: b.hash } }; });
      const acked = i % 20 !== 0;
      yield ['bundle:' + uuidAt('b0000000', i), JSON.stringify(acked ? { version: 1, phase: 'acknowledged', serviceEpoch, refs, proofSha256: proofHash(i) } :
        { version: 1, phase: 'published', serviceEpoch, refs, eventId: uuidAt('e0000000', i), requiredStreams: ['viewing', 'history'] })];
    }
  }
  const record = { tool: 'tests/emr/b/journal_cost.cjs --recovery-probe', started_at: new Date().toISOString(), pid: process.pid,
    host: { platform: process.platform, release: os.release(), arch: process.arch, node: process.version, logical_cpus: os.cpus().length, cpu: os.cpus()[0]?.model ?? null, total_memory_bytes: os.totalmem() },
    cache_state: 'warm (the checkpoint was written moments before by this process; this is not a cold-device measurement)',
    keys_per_stream: N, terminals: 2 * N, bundles: B, directory_every: o.directoryEvery, phases: {}, envelope_budgets: ENVELOPE.recovery_restore_and_full_disk, envelope_maxima: ENVELOPE.cardinality };
  const memory = () => { global.gc?.(); const m = process.memoryUsage(); return { rss: m.rss, heapUsed: m.heapUsed, external: m.external }; };
  const phase = async (name, work) => {
    const before = memory(), cpu0 = process.cpuUsage(), t0 = performance.now();
    let result, error = null;
    try { result = await work(); } catch (e) { error = { code: e?.code ?? e?.name ?? 'Error', message: String(e?.message ?? e).slice(0, 300) }; }
    const ms = performance.now() - t0, cpu = process.cpuUsage(cpu0);
    record.phases[name] = { ms: +ms.toFixed(1), cpu_ms: +((cpu.user + cpu.system) / 1000).toFixed(1), memory_before: before, memory_after: memory(), error, ...(result ?? {}) };
    process.stderr.write(`[probe ${N}] ${name}: ${ms.toFixed(0)} ms ${error ? 'ERROR ' + JSON.stringify(error) : ''}\n`);
  };
  await phase('generate', async () => { const written = EW2.writeNavigableCheckpoint(file, head, map => map === 'terminal' ? terminals() : bundles(), false); return { bytes: written.bytes, digest: written.digest }; });
  fs.writeFileSync(path.join(o.out, 'seal', 'tail.json'), JSON.stringify(tail));
  const bytes = fs.statSync(file).size;
  record.bytes = bytes; record.bytes_per_terminal = +(bytes / (2 * N)).toFixed(1);
  const sequential = (hashing) => () => {
    const fd = fs.openSync(file, 'r'), chunk = Buffer.allocUnsafe(4 * 1024 * 1024); let position = 0, read = 0;
    const h = hashing ? crypto.createHash('sha256') : null;
    try {
      while (position < bytes) {
        const n = fs.readSync(fd, chunk, 0, chunk.length, position); if (!n) break; position += n; read += n;
        if (h) { const slice = chunk.subarray(0, n); let at = 0; for (;;) { const lf = slice.indexOf(10, at); if (lf < 0) { if (at < n) h.update(slice.subarray(at)); break; } if (lf > at) h.update(slice.subarray(at, lf)); at = lf + 1; } }
      }
    } finally { fs.closeSync(fd); }
    return { bytes: read, ...(h ? { digest_of_all_bytes_lf_stripped: h.digest('hex') } : {}) };
  };
  if (o.phases.includes('read')) await phase('read_sequential', sequential(false));
  if (o.phases.includes('hash')) await phase('hash_sequential', sequential(true));
  let scanned = null;
  if (o.phases.includes('scan')) await phase('scan_validate_members_only', async () => {
    const r = EW2.scanCheckpoint(file, { directoryEvery: o.directoryEvery, join: 'none' }); scanned = r;
    return { digest_ok: r.digest === record.phases.generate.digest, counts: r.counts, scan_ms: +r.timing.scanMs.toFixed(1), note: 'bundle-terminal join skipped: member validation and digest only' };
  });
  if (o.phases.includes('lookup')) await phase('scan_validate_join_lookup', async () => {
    const r = EW2.scanCheckpoint(file, { directoryEvery: o.directoryEvery, join: 'lookup' }); scanned = r;
    return { digest_ok: r.digest === record.phases.generate.digest, counts: r.counts, joined: r.joined, scan_ms: +r.timing.scanMs.toFixed(1), join_ms: +r.timing.joinMs.toFixed(1),
      directory_entries: { terminal: r.regions.terminal.directory.length, bundles: r.regions.bundles.directory.length }, navigable: { terminal: r.regions.terminal.navigable, bundles: r.regions.bundles.navigable } };
  });
  if (o.phases.includes('merge')) await phase('scan_validate_join_merge', async () => {
    const r = EW2.scanCheckpoint(file, { directoryEvery: o.directoryEvery, join: 'merge', workDirectory: o.out }); scanned = scanned ?? r;
    return { digest_ok: r.digest === record.phases.generate.digest, counts: r.counts, joined: r.joined, scan_ms: +r.timing.scanMs.toFixed(1), join_ms: +r.timing.joinMs.toFixed(1) };
  });
  if (o.phases.includes('navigate') && scanned) await phase('navigate_lookups', async () => {
    const fd = fs.openSync(file, 'r');
    try {
      const index = new EW2.RegionIndex(fd, scanned.regions.terminal), times = [];
      let found = 0, readCalls = 0; const original = fs.readSync; fs.readSync = (...a) => { readCalls++; return original.apply(fs, a); };
      try {
        for (let i = 0; i < 1000; i++) {
          const k = 1 + (Math.imul(i, 7919) >>> 0) % N, stream = i % 2 ? 'viewing' : 'history', key = stream + ':' + binding(stream, k).attemptId;
          const t = performance.now(); const raw = index.find(key); times.push(performance.now() - t);
          if (raw && JSON.parse(raw.toString()).binding.sequence === k) found++;
        }
        const absent = index.find('viewing:' + uuidAt('a0000000', N + 5)) === null;
        times.sort((a, b) => a - b);
        const q = p => +times[Math.min(times.length - 1, Math.ceil(times.length * p) - 1)].toFixed(3);
        return { lookups: 1000, found, absent_is_null: absent, p50_ms: q(.5), p95_ms: q(.95), p99_ms: q(.99), read_calls: readCalls };
      } finally { fs.readSync = original; }
    } finally { fs.closeSync(fd); }
  });
  // Linear extrapolation to the envelope maxima (labelled, not a measurement).
  const maxima = ENVELOPE.cardinality, terminalsMax = maxima.both_streams_lifetime_attempt_keys, bundlesMax = maxima.lifetime_bundle_attestations;
  const perTerminalMs = name => record.phases[name] && !record.phases[name].error ? record.phases[name].ms / (2 * N) : null;
  const bytesMax = record.bytes_per_terminal * terminalsMax;
  const x = {};
  for (const name of ['read_sequential', 'hash_sequential']) if (record.phases[name] && !record.phases[name].error) x[name] = { mb_per_s: +(bytes / 1048576 / (record.phases[name].ms / 1000)).toFixed(1), seconds_at_600m_keys: +(bytesMax / 1048576 / (bytes / 1048576 / (record.phases[name].ms / 1000))).toFixed(0) };
  for (const name of ['scan_validate_members_only', 'scan_validate_join_lookup', 'scan_validate_join_merge']) if (record.phases[name] && !record.phases[name].error) {
    const p = record.phases[name], scanPerTerminal = p.scan_ms / (2 * N), joinPerBundle = (p.join_ms ?? 0) / Math.max(1, B);
    x[name] = { terminals_per_s: +((2 * N) / (p.scan_ms / 1000)).toFixed(0), scan_seconds_at_600m_keys: +(scanPerTerminal * terminalsMax / 1000).toFixed(0),
      join_seconds_at_100m_bundles: +(joinPerBundle * bundlesMax / 1000).toFixed(0), total_seconds_at_envelope: +((scanPerTerminal * terminalsMax + joinPerBundle * bundlesMax) / 1000).toFixed(0) };
  }
  void perTerminalMs;
  record.extrapolation = { method: 'linear per terminal / per bundle, cache-warm, this host (' + os.cpus().length + ' logical CPUs; the approved host class has 2)', projected_checkpoint_bytes_at_600m_keys: bytesMax, ...x,
    budgets: { warm_owner_restart_ready_seconds_max: 300, cold_validated_pair_recovery_seconds_max: 1800 } };
  const verdicts = [];
  for (const [name, v] of Object.entries(x)) {
    const seconds = v.total_seconds_at_envelope ?? v.seconds_at_600m_keys;
    verdicts.push({ ingredient: name, seconds_at_envelope: seconds, warm_300s: seconds <= 300 ? 'PASS' : 'FAIL', cold_1800s: seconds <= 1800 ? 'PASS' : 'FAIL' });
  }
  record.verdict = verdicts;
  record.finished_at = new Date().toISOString();
  const resultFile = path.join(o.out, `recovery-probe-${N}.json`);
  writeJsonAtomic(resultFile, record);
  if (!o.keep) { fs.rmSync(path.join(o.out, 'seal'), { recursive: true, force: true }); }
  process.stdout.write('RECOVERY_PROBE ' + JSON.stringify({ keys_per_stream: N, bytes, phases: Object.fromEntries(Object.entries(record.phases).map(([k, v]) => [k, v.error ? 'ERROR' : v.ms])), extrapolation: x, verdict: verdicts, file: resultFile }) + '\n');
  return verdicts.length && verdicts.every(v => v.cold_1800s === 'PASS') ? 0 : 3;
}
if (PROBE) {
  recoveryProbe().then(code => { process.exitCode = code; }, error => { process.stderr.write(String(error?.stack ?? error) + '\n'); process.exitCode = 2; });
} else if (LADDER) {
  ladderMain().then(code => { process.exitCode = code; }, error => { process.stderr.write(String(error?.stack ?? error) + '\n'); process.exitCode = 2; });
} else if (out === '--init') {
  const dir = process.argv[5];
  const owner = new CO.StateCoordinator(dir, process.platform === 'linux' ? undefined : request => EW.executeExternal(request));
  new S4.AccessSeal(dir, jcostSql(), new J4.FailureJournal(dir, owner)).recoverAtStart(JCOST_PAIR, crypto.randomUUID())
    .then(() => { owner.close(); process.exit(0); }, error => { process.stderr.write(String(error?.stack ?? error) + '\n'); process.exit(1); });
} else if (out === '--sample') {
  const [label, rep, n] = process.argv.slice(5);
  sample(label, Number(rep), Number(n)).then(row => console.log(JSON.stringify(row)), error => { process.stderr.write(String(error?.stack ?? error) + '\n'); process.exit(1); });
} else {
  const rows = [], reps = Number(process.env.JOURNAL_REPS || 5);
  for (let rep = 0; rep < reps; rep++) {
    const sizes = [0, 10000, 150000], offset = rep % sizes.length;
    const order = [...sizes.slice(offset), ...sizes.slice(0, offset)]; if (rep % 2) order.reverse();
    for (const n of order) for (const label of rep % 2 ? ['r4d', 'r3'] : ['r3', 'r4d']) {
      // A state owner's lifetime ends with its process. Isolate each fixture's
      // lifetime so deleted journals do not leave their retained indexes and
      // ownership fences alive during the next, unrelated size measurement.
      const run = spawnSync(process.execPath, [__filename, r3, r4b, '--sample', label, String(rep), String(n)],
        { encoding: 'utf8', timeout: 60000 });
      if (run.status !== 0) throw new Error(`journal sample failed: ${run.stderr || run.error}`);
      const row = JSON.parse(run.stdout); rows.push(row); console.log(JSON.stringify(row));
    }
  }
  fs.writeFileSync(out, JSON.stringify(rows, null, 1));
}
