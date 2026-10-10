/* D878: Opus's r4 review real-code A/B harness, reused for the pinned r3 and candidate.
 * The shared DB boundary models per-stream head locks through COMMIT, a nine-connection
 * pool, 0.5 ms statements and 1 ms COMMIT. Snapshots use an immutable sequence ceiling
 * over append-only rows, without injecting O(retained) copying into the DB double.
 * Both revisions use precise setImmediate timers and real protected-state filesystem IO.
 * Linux uses the actual single-owner flock(1) coordinator; Windows can emulate its measured cost.
 * No DB, network or existing fixture. Each process owns an empty synthetic temp directory.
 * Usage: <checkout> <label> <concurrency/rate> <retained> <out.jsonl> [SQL_MS] [COMMIT_MS] [FLOCK_MS] [POOL]
 */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const Module = require('node:module');
const [root, label, concText, prefillText, out, sqlText = '0.5', commitText = '1.0', flockText = '1.0', poolText = '9'] = process.argv.slice(2);
const C_REQ = Number(concText), PREFILL = Number(prefillText), SQL_MS = Number(sqlText), COMMIT_MS = Number(commitText), FLOCK_MS = Number(flockText), POOL = Number(poolText);

// ── precise timers (both revisions) ──
const timers = new Set(); let spinning = false;
function tick() {
  const now = performance.now();
  for (const t of [...timers]) if (t.at <= now) { timers.delete(t); t.fn(...t.args); }
  if (timers.size) setImmediate(tick); else spinning = false;
}
global.setTimeout = (fn, ms = 0, ...args) => { const t = { at: performance.now() + Math.max(0, Number(ms) || 0), fn, args, unref() { return t; }, ref() { return t; } }; timers.add(t); if (!spinning) { spinning = true; setImmediate(tick); } return t; };
global.clearTimeout = t => { timers.delete(t); };
const delay = ms => ms > 0 ? new Promise(r => setTimeout(r, ms)) : new Promise(r => setImmediate(r));
const busy = ms => { const end = performance.now() + ms; while (performance.now() < end) { /* spawnSync(flock) blocks the loop */ } };

// ── product modules, compiled unmodified ──
const ts = require(process.env.KIN_EMR_TYPESCRIPT || path.resolve(__dirname, '../../../api/node_modules/typescript'));
const config = ts.readConfigFile(path.join(root, 'api/tsconfig.json'), ts.sys.readFile);
require.extensions['.ts'] = (m, f) => m._compile(ts.transpileModule(fs.readFileSync(f, 'utf8'), { compilerOptions: config.config.compilerOptions, fileName: f }).outputText, f);
const originalLoad = Module._load;
Module._load = function (request, ...rest) { return request === '@prisma/client' ? { PrismaClient: class {} } : originalLoad.call(this, request, ...rest); };
const src = p => path.join(root, 'api/src/emr-runtime', p);
const C = require(src('contract.ts')), RT = require(src('store.ts')), S = require(src('seal.ts')), J = require(src('failure-journal.ts'));
const v4 = fs.existsSync(src('coordinator.ts'));
const CO = v4 ? require(src('coordinator.ts')) : null, EW = v4 ? require(src('external-writer.ts')) : null;
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const zero = '0'.repeat(64);

// ── PostgreSQL boundary model ──
class Mutex { constructor() { this.held = false; this.q = []; }
  acquire() { if (!this.held) { this.held = true; return Promise.resolve(); } return new Promise(r => this.q.push(r)); }
  release() { const n = this.q.shift(); if (n) n(); else this.held = false; } }
class Semaphore { constructor(n) { this.n = n; this.q = []; }
  acquire() { if (this.n > 0) { this.n--; return Promise.resolve(); } return new Promise(r => this.q.push(r)); }
  release() { const n = this.q.shift(); if (n) n(); else this.n++; } }
const pool = new Semaphore(POOL);
const detail = { lock_hold_ms: [], lock_wait_ms: [], coordinator_ms: {}, confirm_ms: [], append_tx_ms: [] };
let readRows = 0;
const streams = ['viewing', 'history'];
const L = { s: Object.fromEntries(streams.map(s => [s, { chainId: crypto.randomUUID(), head: { sequence: 0, hash: zero }, entries: [], byEvent: new Map(), lock: new Mutex() }])),
  markers: new Map(), markerByAttempt: new Map() };
const stored = e => ({ sequence: e.sequence, previousHash: e.previousHash, hash: e.hash, kind: e.kind, statutoryAct: e.statutoryAct, eventId: e.eventId,
  payload: e.payload, contentSha256: e.contentSha256, storedAt: e.storedAt });
function after(list, a, limit) { if (!list.length) return []; const i = Math.max(0, a - list[0].sequence + 1); return list.slice(i, i + limit); }
function view(snap) {   // reads of committed facts (snap: a frozen copy for RepeatableRead, or live state)
  const S0 = snap || L;
  return {
    verificationPage: async (s, a, limit) => {
      await delay(SQL_MS); // one real SELECT joins the four existing reader functions
      const chain=S0.s[s], first=chain.entries[0]?.sequence<=chain.head.sequence?chain.entries[0]:null;
      const rows=after(chain.entries,a,Math.min(limit,Math.max(0,chain.head.sequence-a))).map(stored);
      readRows+=rows.length+(first?1:0);
      return {tail:{chainId:chain.chainId,...chain.head},first,
        entries:rows.map(entry=>({entry,marker:S0.markers.get(s+':'+entry.sequence)??null}))};
    },
    tail: async s => { await delay(SQL_MS); return { chainId: S0.s[s].chainId, ...S0.s[s].head }; },
    entriesAfter: async (s, a, limit) => { await delay(SQL_MS); const rows = after(S0.s[s].entries, a, Math.min(limit, Math.max(0, S0.s[s].head.sequence - a))).map(stored); readRows += rows.length; return rows; },
    entryForEvent: async (s, id) => { await delay(SQL_MS); const e = S0.s[s].byEvent.get(id); return e && e.sequence <= S0.s[s].head.sequence ? stored(e) : null; },
    markerForSlot: async (s, q) => { await delay(SQL_MS); return q <= S0.s[s].head.sequence ? S0.markers.get(s + ':' + q) ?? null : null; },
    markerForAttempt: async (s, a) => { await delay(SQL_MS); const m=S0.markerByAttempt.get(s + ':' + a); return m && m.sequence <= S0.s[s].head.sequence ? m : null; },
  };
}
// Snapshot is a committed sequence ceiling over append-only rows, matching MVCC.
// Copying the whole retained array/map would insert O(retained) work into the DB double.
const freeze = () => ({ s: Object.fromEntries(streams.map(s => [s, { chainId: L.s[s].chainId, head: { ...L.s[s].head }, entries: L.s[s].entries, byEvent: L.s[s].byEvent }])),
  markers: L.markers, markerByAttempt: L.markerByAttempt });
const pooled = fn => async (...a) => { await pool.acquire(); try { return await fn(...a); } finally { pool.release(); } };
const live = view(null);
const sql = {
  verificationPage: pooled(live.verificationPage), tail: pooled(live.tail), entriesAfter: pooled(live.entriesAfter), entryForEvent: pooled(live.entryForEvent),
  markerForSlot: pooled(live.markerForSlot), markerForAttempt: pooled(live.markerForAttempt), placement: async () => [],
  snapshot: async work => { await pool.acquire(); try { await delay(SQL_MS); const v = view(freeze()); const inner = { ...v, snapshot: w => w(inner), withWriterFence: w => w(inner) }; const r = await work(inner); await delay(COMMIT_MS); return r; } finally { pool.release(); } },
};
sql.withWriterFence = sql.snapshot;
let txSeq = 0;
const db = {
  async $transaction(work) {
    await pool.acquire();
    const tx = { id: ++txSeq, staged: { viewing: [], history: [] }, locks: new Set(), markers: [], lockedAt: {} };
    try {
      await delay(SQL_MS); // BEGIN
      const value = await work(tx);
      for (const m of tx.markers) if (!(m.generation > 0)) throw Object.assign(new Error('CommitMarkerRequired'), { code: 'P2010', meta: { code: 'EB008' } });
      await delay(COMMIT_MS);
      for (const s of streams) for (const e of tx.staged[s]) { L.s[s].entries.push(e); L.s[s].byEvent.set(e.eventId, e); L.s[s].head = { sequence: e.sequence, hash: e.hash }; }
      for (const m of tx.markers) { L.markers.set(m.stream + ':' + m.sequence, m); L.markerByAttempt.set(m.stream + ':' + m.attemptId, m); }
      return value;
    } finally { for (const s of tx.locks) { detail.lock_hold_ms.push(performance.now() - tx.lockedAt[s]); L.s[s].lock.release(); } pool.release(); }
  },
};
async function stage(tx, stream, eventId, payload, act, attemptId, bundleId) {
  if (!tx.locks.has(stream)) { const w0 = performance.now(); await L.s[stream].lock.acquire(); tx.locks.add(stream); tx.lockedAt[stream] = performance.now(); detail.lock_wait_ms.push(tx.lockedAt[stream] - w0); }
  await delay(SQL_MS);
  const chain = L.s[stream], prev = tx.staged[stream].at(-1) ?? chain.head;
  const sequence = prev.sequence + 1, hash = C.entryHash(sequence, prev.hash, payload), storedAt = new Date().toISOString();
  const e = { sequence, previousHash: prev.hash, hash, kind: stream === 'history' ? 'history' : 'access', statutoryAct: act, eventId, payload, contentSha256: sha(payload), storedAt };
  tx.staged[stream].push(e);
  if (attemptId) tx.markers.push({ stream, chainId: chain.chainId, attemptId, bundleId, kind: e.kind, eventId, sequence, previousHash: e.previousHash, hash, contentSha256: e.contentSha256, generation: 0, proofDigest: null });
  return { chainId: chain.chainId, sequence, previousHash: e.previousHash, hash, storedAt, replay: false };
}
class Store extends RT.AccessLedgerStore {
  async enterWriter() { await delay(SQL_MS); }
  async appendRow(tx, stream, eventId, payload, act, attemptId, bundleId) { return stage(tx, stream, eventId, payload, act, attemptId, bundleId); }
  async bindCommit(tx, binding) { await delay(SQL_MS); const m = tx.markers.find(x => x.attemptId === binding.attemptId && x.stream === binding.stream); Object.assign(m, binding); }
}
function authEvent() {
  const eventId = crypto.randomUUID(), who = { id: crypto.randomUUID(), issuer: 'https://identity.example.test', subject: 'synthetic-reviewer' };
  const known = value => ({ status: 'known', value });
  return { formatVersion: 2, branch: 'online-auth', surface: 'GET auth/callback', eventId, userId: known(who), rolesAtTime: known(['radiologist']),
    rightsVersion: known(1), actingInstitution: known('synthetic-hospital'), managingInstitution: known('synthetic-hospital'), occurredAt: new Date().toISOString(),
    trustedProxyIp: known({ address: '192.0.2.1', source: 'trusted-proxy' }), cause: 'user-view',
    context: { basis: 'authentication', studyId: null, relatedStudyId: null, reason: null }, executor: 'member', affectedIdentity: known(who),
    session: known('authref:' + crypto.randomUUID()), targets: [], action: 'auth.login', result: 'succeeded',
    auth: { endCause: null, failureCause: null, trigger: null }, requestId: 'synthetic-request', auditLinkId: 'audit:' + crypto.randomUUID(), relatedEventId: null };
}
const q = (xs, p) => xs[Math.min(xs.length - 1, Math.ceil(xs.length * p) - 1)];

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-ab-'));
  let calls = 0;
  try {
    const coordinator = v4 ? new CO.StateCoordinator(dir, process.platform === 'linux' ? undefined : request => {
      busy(FLOCK_MS); return request.operation === 'owner-alive' ? false : EW.executeExternal(request);
    }) : null;
    if (coordinator) {
      const call = coordinator.call.bind(coordinator);
      coordinator.call = (operation, value) => { calls++; const t0 = performance.now();
        try { return call(operation, value); }
        finally { (detail.coordinator_ms[operation] ||= []).push(performance.now() - t0); }
      };
    }
    const journal = v4 ? new J.FailureJournal(dir, coordinator) : new J.FailureJournal(dir);
    const seal = new S.AccessSeal(dir, sql, journal);
    if (v4) await seal.recoverAtStart(); else await seal.recover();
    if (PREFILL) {   // an already sealed retained chain of PREFILL viewing entries
      const v = L.s.viewing;
      for (let i = 0; i < PREFILL; i++) {
        const { event, text, contentSha256 } = C.canonicalPayload(authEvent());
        const sequence = v.head.sequence + 1, hash = C.entryHash(sequence, v.head.hash, text);
        const e = { sequence, previousHash: v.head.hash, hash, kind: 'access', statutoryAct: 'none', eventId: event.eventId, payload: text, contentSha256, storedAt: new Date().toISOString() };
        v.entries.push(e); v.byEvent.set(e.eventId, e); v.head = { sequence, hash };
      }
      const position = { chainId: v.chainId, sequence: v.head.sequence, hash: v.head.hash };
      if (v4) journal.coordinator.call('update', st => { st.tail = { ...st.tail, streams: { ...st.tail.streams, viewing: position }, generation: ++st.generation }; });
      else { const cur = seal.read(); seal['write']({ streams: { ...cur.streams, viewing: position }, sealedAt: new Date().toISOString() }); }
    }
    const store = new Store(db, sql, seal, journal);
    const confirm0 = store.confirm.bind(store); store.confirm = async a => { const t0 = performance.now(); try { return await confirm0(a); } finally { detail.confirm_ms.push(performance.now() - t0); } };
    for (let i = 0; i < 5; i++) await store.append(authEvent());   // warm-up (JIT, files)
    calls = 0; readRows = 0; for (const k of Object.keys(detail)) detail[k] = Array.isArray(detail[k]) ? [] : {};
    // Sustained mode: C_REQ arrivals per second for DURATION_MS (open loop), every receipt awaited.
    const DURATION_MS = Number(process.env.AB_DURATION_MS || 5000), started = performance.now(), pending = [];
    let snapshots = 0; const snap0 = sql.snapshot; sql.snapshot = async w => { snapshots++; return snap0(w); };
    for (let i = 0; performance.now() - started < DURATION_MS; i++) {
      const due = started + i * 1000 / C_REQ; while (performance.now() < due) await delay(0.2);
      const e = authEvent(), s = performance.now();
      pending.push(store.append(e).then(() => ({ ms: performance.now() - s, at: s - started }), error => ({ ms: performance.now() - s, at: s - started, error: error.code || error.name, detail: String(error.message).slice(0, 160) })));
    }
    const rows = await Promise.all(pending); calls = calls; globalThis.__snapshots = snapshots;
    const wall = performance.now() - started, ok = rows.filter(r => !r.error).map(r => r.ms).sort((a, b) => a - b);
    const all = rows.map(r => r.ms).sort((a, b) => a - b);
    const result = { label, version: v4 ? 'r4d' : 'r3', concurrency: C_REQ, prefill: PREFILL, sql_ms: SQL_MS, commit_ms: COMMIT_MS, flock_ms: v4 ? FLOCK_MS : null, pool: POOL,
      failures: rows.length - ok.length, errors: [...new Set(rows.filter(r => r.error).map(r => r.error + ':' + r.detail))],
      p50: +q(all, .5).toFixed(1), p95: +q(all, .95).toFixed(1), p99: +q(all, .99).toFixed(1), max: +all.at(-1).toFixed(1), wall_ms: +wall.toFixed(1),
      read_rows: readRows, coordinator_calls: v4 ? calls : null, mode: 'sustained', rate_per_s: C_REQ, duration_ms: Number(process.env.AB_DURATION_MS || 5000), requests: rows.length, seal_snapshots: globalThis.__snapshots, late_half_p95: +q(rows.filter(r => r.at > Number(process.env.AB_DURATION_MS || 5000) / 2).map(r => r.ms).sort((a, b) => a - b), .95).toFixed(1), sealed_through: (seal.read()).streams.viewing.sequence, at: new Date().toISOString() };
    if (process.env.AB_DETAIL === '1') { const st = xs => { xs = xs.slice().sort((a, b) => a - b); return xs.length ? { n: xs.length, sum: +xs.reduce((a, b) => a + b, 0).toFixed(1), p50: +q(xs, .5).toFixed(2), p95: +q(xs, .95).toFixed(2) } : null; };
      result.detail = { lock_hold_ms: st(detail.lock_hold_ms), lock_wait_ms: st(detail.lock_wait_ms), confirm_ms: st(detail.confirm_ms), coordinator_ms: Object.fromEntries(Object.entries(detail.coordinator_ms).map(([k, v]) => [k, st(v)])) }; }
    fs.appendFileSync(out, JSON.stringify(result) + '\n');
    console.log(JSON.stringify(result));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(e => { console.error(e.stack || e); process.exitCode = 2; });
