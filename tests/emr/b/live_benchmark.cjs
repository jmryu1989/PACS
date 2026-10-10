/* D941 live driver: one process per revision survives every interleaved block.
 * Every timed operation uses the compiled product store against PostgreSQL.
 * Prefill is unmeasured but uses that same append/receipt path.
 */
const readline = require('node:readline');
const { performance } = require('node:perf_hooks');
const { instrument, summary } = require('./throughput.cjs');
const send = value => new Promise(resolve => process.stdout.write('EMR_BENCHMARK ' + JSON.stringify(value) + '\n', resolve));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run({ prisma, store, seal, sql, Sql, event }) {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  await send({ ready: true });
  let previousReceipt;
  for await (const line of input) {
    const command = JSON.parse(line);
    if (command.kind === 'close') break;
    try {
      if (command.kind === 'plans') {
        await send(await require('./verification_plan.cjs').check(prisma, Sql));
        continue;
      }
      if (command.kind === 'prefill') {
        const before = (await sql.tail('viewing')).sequence;
        // Bounded waves use exactly the application path, including every
        // durable receipt. No superuser fixture skips reservations or sealing.
        for (let left = command.count; left > 0; left -= 24) {
          await Promise.all(Array.from({ length: Math.min(24, left) }, () => store.append(event())));
          if (left % 1200 === command.count % 1200)
            process.stderr.write('EMR_PREFILL_PROGRESS ' + JSON.stringify({ completed: command.count - left + Math.min(24, left), total: command.count }) + '\n');
        }
        await send({ prefilled: command.count, before, after: (await sql.tail('viewing')).sequence });
        continue;
      }
      const probe = instrument(prisma, store, seal, { headProbe: true });
      try {
        const results = [], started = performance.now();
        if (command.kind === 'gap-probe') {
          // Diagnostic only: balance 0/200 ms ordering within one warm process.
          // Receipt latency excludes the deliberate pause, as in the main run.
          for (let pair = 0; pair < command.count / 2; pair++) {
            for (const gap of (pair % 2 ? [command.idle_ms, 0] : [0, command.idle_ms])) {
              if (gap) await pause(gap);
              const actualGap = previousReceipt === undefined ? null : performance.now() - previousReceipt;
              const row = await probe.run(event());
              previousReceipt = performance.now();
              results.push({ ...row, scheduled_gap_ms: gap, idle_gap_ms: actualGap, pair });
            }
          }
        } else if (command.kind === 'concurrent') {
          results.push(...await Promise.all(Array.from({ length: command.count }, () => probe.run(event()))));
        } else if (command.kind === 'sustained') {
          const pending = [];
          for (let n = 0; n < command.count; n++) {
            await pause(Math.max(0, started + n * 1000 / command.rps - performance.now()));
            pending.push(probe.run(event()));
          }
          results.push(...await Promise.all(pending));
        } else {
          for (let n = 0; n < command.count; n++) {
            if (n && command.idle_ms) await pause(command.idle_ms);
            const gap = previousReceipt === undefined ? null : performance.now() - previousReceipt;
            const row = await probe.run(event());
            previousReceipt = performance.now();
            results.push({ ...row, idle_gap_ms: gap, segment_request: n });
          }
        }
        await send({ command, results, summary: summary(results), drain_groups: probe.drains,
          elapsed_ms: performance.now() - started, tail: await sql.tail('viewing') });
      } finally { probe.restore(); }
    } catch (error) { await send({ error: error.code || error.name, detail: String(error.stack) }); }
  }
  return { closed: true };
}
module.exports = { run };
