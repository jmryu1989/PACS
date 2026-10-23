'use strict';
// Source: D1732 profile plus the explicit D1770 replacement-order delta.
// These are first-site engineering budgets, not statutory numbers or measured
// capacity. No larger-site allowance follows from this declaration.
const { createHash } = require('node:crypto');
const profile = {
  id: 'A11-FIRST-HOSPITAL-D1732-20261023-PG-v1',
  baseId: 'A11-FIRST-HOSPITAL-D1732-20261023-v1',
  baseSha256: '1cd97cb61decdd10cdf6efaa9ddcc445c2a093a058a33efe20e3109d41bf641d',
  source: 'D1770 implementer-order.md section 5, measured first-site run',
  keys: 10000000, logicalOperationsMaximum: 6000000, pendingMaximum: 128,
  normalRetained: { viewing: 1200000, history: 1200000 },
  dualHeavyRetainedMaximum: { viewing: 1200000, history: 5000000 },
  clients: { normal: 8, burst: 16 },
  rungs: ['small',100000,1000000,10000000],
  workloads: [
    { kind:'logical-operations', perSecond:2, seconds:3600 },
    { kind:'dual-entries', perSecond:4, seconds:600 },
    { kind:'admissions-lookups', perSecond:12, seconds:600 },
    { kind:'burst-logical-operations', perSecond:10, dualEntriesPerSecond:20, seconds:60 },
  ],
  latencyMs: { admissionP95:100, durableReceiptP95:500, durableReceiptP99:1000 },
  unexpectedSteadyErrors:0,
  host: { os:'Linux', node:22, logicalCpus:2, approximateRamGiB:7.76,
    pgGiB:2, apiRssGiB:1, otherServiceReserveGiB:2.5, swapDependence:false },
  recovery: { warmSeconds:300, coldSeconds:1800, warmRuns:1, coldRuns:1,
    backupHours:8, restoreAndVerifyHours:8, rpoHours:24 },
  storageGiB: { primary:192, backup:1536, restoreScratch:192 },
  storageFractions: { warning:0.70, measuredPeakMaximum:0.80, refuseNewAdmission:0.90 },
  planningBytes: { perAttemptKey:4096, perRetainedRow:4096 },
  reverifyTrigger: 'A11-SITE-RESIZE-D1732: before initial real use and before a larger site; bind actual workload first',
  removed: ['external-state-process','bundles-and-acks','hash-chain','full-history-sweep','custom-WAL-caps','legacy-conversion','percentage-stress-ladder'],
  baseline: { status:'UNBOUND', required:'predeclared B1 baseline on the retained workloads; prototype is not a baseline' },
  qualification: 'NOT_MEASURED',
};
const sha256 = createHash('sha256').update(JSON.stringify(profile)).digest('hex');
module.exports = { profile, sha256 };
if (require.main === module) process.stdout.write(JSON.stringify({ profile, sha256 }, null, 2) + '\n');
