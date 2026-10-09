/* Opus r4 review: cost of ONE failure-journal record() as the journal grows, r3 (in-memory index, loaded once at start)
 * vs r4c (persistent coordinator index, incrementally refreshed for other writers).
 * Usage: node journal_cost.cjs <r3 checkout> <candidate checkout> <out.json>. Synthetic records only. */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
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
const rows = [], reps=Number(process.env.JOURNAL_REPS || 5);
for (let rep=0;rep<reps;rep++) {
 const sizes=[0,10000,150000], offset=rep%sizes.length;
 const order=[...sizes.slice(offset),...sizes.slice(0,offset)];if(rep%2)order.reverse();
 for(const n of order) {
  const versions=[['r3', d => new J3.FailureJournal(d)], ['r4c', (d, lock, fd) => new J4.FailureJournal(d, new CO.StateCoordinator(d, request => {
    if(lock)lock.flock(fd,true);
    try{return EW.executeExternal(request);}finally{if(lock)lock.flock(fd,false);}
  }))]];
  if(rep%2)versions.reverse();
  for (const [label, make] of versions) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opus-jcost-')); seed(dir, n);
    const lock=process.env.KIN_EMR_LOCK_BINDING?require(process.env.KIN_EMR_LOCK_BINDING):null, fd=fs.openSync(path.join(dir,'writer.lock'),'a+');
    try {
      const t0 = performance.now(), j = make(dir,lock,fd), open_ms = performance.now() - t0, times = [];
      let readBytes=0;
      const fileRead=fs.readFileSync,rangeRead=fs.readSync;
      fs.readFileSync=function(...args){const v=fileRead.apply(this,args);readBytes+=Buffer.byteLength(v);return v;};
      fs.readSync=function(...args){const n=rangeRead.apply(this,args);readBytes+=n;return n;};
      try {
        for (let i = 0; i < 20; i++) { const s = performance.now(); j.record('ledger-unavailable:transaction:' + crypto.randomUUID() + ':commit-unknown', 'ledger-unavailable', { eventId: crypto.randomUUID(), cause: 'commit-unknown' }); times.push(performance.now() - s); }
      } finally { fs.readFileSync=fileRead;fs.readSync=rangeRead; }
      times.sort((a, b) => a - b);
      const bytes = fs.statSync(path.join(dir, 'journal', 'failure-journal.jsonl')).size;
      rows.push({ version: label, rep, records: n, journal_mib: +(bytes / 1048576).toFixed(1), open_ms: +open_ms.toFixed(1), read_bytes:readBytes,
        p50:times[9],p95:times[18],p99:times[19],samples:times });
      console.log(JSON.stringify(rows.at(-1)));
    } finally { fs.closeSync(fd); fs.rmSync(dir, { recursive: true, force: true }); }
  }
}
}
fs.writeFileSync(out, JSON.stringify(rows, null, 1));
