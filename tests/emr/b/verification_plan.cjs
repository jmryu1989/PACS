/* REQ-D941 -> RISK-EMR-RECEIPT-JIT -> L03c plan guard.
 * Capture the actual tagged statements by executing PrismaLedgerSql, rather
 * than duplicating product SQL or asserting its implementation text.
 */
const assert = require('node:assert/strict');
// A generous ceiling for a 1000-row verification page, still 10x below the
// deployed PostgreSQL default jit_above_cost=100000. Test both custom and
// generic prepared plans: parameter estimates must not reintroduce JIT.
const VERIFICATION_PLAN_COST_LIMIT = 10000;
// Regression witness: the shipped r4c-r6 shape (same functions/permissions).
// It is intentionally unbounded to prove the guard detects the original class.
const UNBOUNDED_VERIFICATION = `SELECT t.chain_id::text AS tail_chain_id,
  t.sequence AS tail_sequence, t.hash AS tail_hash, f.sequence AS first_sequence,
  f.previous_hash AS first_previous_hash, e.*, CASE WHEN m.sequence IS NULL THEN NULL ELSE to_jsonb(m) END AS commit_marker
  FROM emr_access.chain_tail($1::text) t
  LEFT JOIN LATERAL emr_access.entries_after($1::text, 0, 1) f ON true
  LEFT JOIN LATERAL emr_access.entries_after($1::text, $2::bigint, $3::integer) e ON true
  LEFT JOIN LATERAL emr_access.commit_marker_for_slot($1::text, e.sequence) m ON true ORDER BY e.sequence`;

function planVerdict(document) {
  const plan = typeof document === 'string' ? JSON.parse(document) : document;
  const root = plan[0];
  const cost = root.Plan['Total Cost'];
  const jit = Object.hasOwn(root, 'JIT');
  assert(!jit, 'receipt verification must not invoke per-execution JIT');
  assert(cost <= VERIFICATION_PLAN_COST_LIMIT, `verification cost ${cost} exceeds ${VERIFICATION_PLAN_COST_LIMIT}`);
  return { jit, cost, execution_ms: root['Execution Time'] };
}

async function check(prisma, Sql) {
  const captured = [], statements = [];
  let latest;
  const recorder = { $queryRaw: (strings, ...values) => {
    const text = strings.reduce((s, part, n) => s + (n ? '$' + n : '') + part, '');
    captured.push({ text, values });
    return prisma.$queryRaw(strings, ...values);
  } };
  const sql = new Sql(recorder), tail = await sql.tail('viewing');
  for (const stream of ['viewing', 'history']) {
    const head = await sql.tail(stream);
    await sql.entriesAfter(stream, 0, 1000);
    await sql.entryForEvent(stream, 'absent-synthetic-event');
    await sql.markerForSlot(stream, head.sequence);
    await sql.markerForAttempt(stream, 'absent-synthetic-attempt');
    for (const size of [1, 10, 1000]) {
      const after = Math.max(0, head.sequence - size);
      const page = await sql.verificationPage(stream, after, size);
      if (stream === 'viewing' && size === 1) latest = captured.at(-1);
      const statementCount = captured.length;
      const entries = await sql.entriesAfter(stream, after, size);
      assert.deepEqual(page.tail, head);
      const first = (await sql.entriesAfter(stream, 0, 1))[0];
      assert.deepEqual(page.first, first ? { sequence: first.sequence, previousHash: first.previousHash } : null);
      assert.deepEqual(page.entries.map(e => e.entry), entries);
      for (const row of page.entries) assert.deepEqual(row.marker, await sql.markerForSlot(stream, row.entry.sequence));
      captured.length = statementCount; // independent result oracle, not additional plan shapes
    }
  }
  // Keep all parameter shapes (one-row, full-page, empty stream). EXPLAIN uses
  // the runtime credential; these statements do not mutate the ledger.
  for (const [n, query] of captured.entries()) {
    if (statements.some(s => s.text === query.text && JSON.stringify(s.values) === JSON.stringify(query.values))) continue;
    statements.push(query);
  }
  const rows = [], comparison = [];
  assert(latest, 'capture a populated one-row verification page');
  for (let repeat = 0; repeat < 3; repeat++) {
    const before = await prisma.$queryRawUnsafe('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + UNBOUNDED_VERIFICATION, 'viewing', tail.sequence - 1, 1);
    assert.throws(() => planVerdict(before[0]['QUERY PLAN']), /JIT|cost/, 'old shape must be killed by the guard');
    const after = await prisma.$queryRawUnsafe('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + latest.text, ...latest.values);
    const verdict = planVerdict(after[0]['QUERY PLAN']);
    assert.deepEqual(await prisma.$queryRawUnsafe(latest.text, ...latest.values),
      await prisma.$queryRawUnsafe(UNBOUNDED_VERIFICATION, 'viewing', tail.sequence - 1, 1), 'old/new raw results identical');
    comparison.push({ before_plan: before[0]['QUERY PLAN'], after_plan: after[0]['QUERY PLAN'],
      before_ms: before[0]['QUERY PLAN'][0]['Execution Time'], after_ms: verdict.execution_ms, explain_jit: verdict.jit });
  }
  for (const mode of ['force_custom_plan', 'force_generic_plan']) {
    // These test-session settings control planner cache choice, never jit.
    await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET LOCAL plan_cache_mode = ' + mode);
      for (const [n, query] of statements.entries()) {
        // PREPARE/EXECUTE with SQL literals is restricted to our captured typed
        // primitive values; the product itself continues to use bound parameters.
        const literal = value => typeof value === 'number' ? String(value) : "'" + String(value).replaceAll("'", "''") + "'";
        const name = 'emrb_plan_' + n;
        await tx.$executeRawUnsafe('PREPARE ' + name + ' AS ' + query.text);
        try {
          const document = await tx.$queryRawUnsafe('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) EXECUTE ' + name + '(' + query.values.map(literal).join(',') + ')');
          rows.push({ mode, statement: query.text, values: query.values, plan: document[0]['QUERY PLAN'],
            ...planVerdict(document[0]['QUERY PLAN']) });
        } finally { await tx.$executeRawUnsafe('DEALLOCATE ' + name); }
      }
    }, { maxWait: 10000, timeout: 120000 });
  }
  return { guard: 'L03c verification_plan.cjs', cost_limit: VERIFICATION_PLAN_COST_LIMIT,
    retained_rows: tail.sequence, result_equivalence: true, comparison, statements: rows };
}
module.exports = { check, planVerdict, VERIFICATION_PLAN_COST_LIMIT };
