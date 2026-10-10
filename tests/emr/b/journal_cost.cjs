/* Opus r4 review: cost of ONE failure-journal record() as the journal grows, r3 (in-memory index, loaded once at start)
 * vs r4c (persistent coordinator index, incrementally refreshed for other writers).
 * Usage: node journal_cost.cjs <r3 checkout> <candidate checkout> <out.json>. Synthetic records only. */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { spawnSync } = require('node:child_process');
const ts = require(process.env.KIN_EMR_TYPESCRIPT || path.resolve(__dirname, '../../../api/node_modules/typescript'));
require.extensions['.ts'] = (m, f) => m._compile(ts.transpileModule(fs.readFileSync(f, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, esModuleInterop: true }, fileName: f }).outputText, f);
const [r3, r4b, out] = process.argv.slice(2);
const J3 = require(path.join(r3, 'api/src/emr-runtime/failure-journal.ts'));
const J4 = require(path.join(r4b, 'api/src/emr-runtime/failure-journal.ts'));
const CO = require(path.join(r4b, 'api/src/emr-runtime/coordinator.ts')), EW = require(path.join(r4b, 'api/src/emr-runtime/external-writer.ts'));
function seed(dir, n) {
  fs.mkdirSync(path.join(dir, 'journal'), { recursive: true });
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
function sample(label, rep, n) {
  const make = label === 'r3' ? d => new J3.FailureJournal(d) : d => new J4.FailureJournal(d,
    new CO.StateCoordinator(d, process.platform === 'linux' ? undefined : request => EW.executeExternal(request)));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-jcost-')); seed(dir, n);
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
if (out === '--sample') {
  const [label, rep, n] = process.argv.slice(5);
  console.log(JSON.stringify(sample(label, Number(rep), Number(n))));
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
