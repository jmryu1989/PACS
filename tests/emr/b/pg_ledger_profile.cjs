'use strict';
// D1806/v2 fixes the stream-attempt-key population and shortens the A11 workload.
// First-site engineering assumptions, not statutory capacity numbers.
const { createHash } = require('node:crypto');
const profile = {
  id: 'A11-FIRST-HOSPITAL-D1732-B2-D1806',
  source: 'D1806; implementer-order-v2 item 8; b2-order-v2-crosscheck X3',
  firstSiteDeclared: 5475000, cardinalityUnit: 'stream-attempt-key',
  marginKeys: 525000, keys: 6000000,
  marginBasis: 'D1806 accepts 6M stream-attempt keys; not an equivalence to historical logical operations',
  workloads: [{ kind: 'logical-operations', perSecond: 2, seconds: 600 }],
  latencyMs: { admissionP95: 100, durableReceiptP95: 500 },
  unexpectedSteadyErrors: 0,
  recovery: { warmSeconds: 300, warmRuns: 1, signal: 'SIGKILL API+PG' },
  measurements: ['peakApiRssBytes', 'vmRamBytes', 'diskBytes'],
  reverifyTrigger: 'A11-SITE-RESIZE-D1732: verify actual first-site assumptions before use and re-verify before a larger site',
};
const sha256 = createHash('sha256').update(JSON.stringify(profile)).digest('hex');
module.exports = { profile, sha256 };
if (require.main === module) process.stdout.write(JSON.stringify({ profile, sha256 }, null, 2) + '\n');
