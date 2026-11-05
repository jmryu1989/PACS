'use strict';
/* A PostgreSQL-shaped transaction double shared by the B2 pure suites (B2-COMMIT plan section 5, PC:91).
 *
 * It keeps apart four things a real transaction keeps apart: what the callback returned, what became durable, what the
 * client was answered, and whether the status of a transaction can be read afterwards. A transaction gets a full XID the
 * first time it writes, locks a row or asks for its id (as PostgreSQL assigns one), and its COMMIT then follows the next
 * entry of `plans`:
 *   'commit'       durable, committed, answered with the callback's value;
 *   'silent-abort' nothing durable, aborted, yet answered with the callback's value (Prisma 5.22 resolving a COMMIT that a
 *                  deferred trigger failed, observed on PostgreSQL 2026-11-04);
 *   'abort'        nothing durable, aborted, answered with `error` (a COMMIT error, possibly with a known Prisma code);
 *   'lost'         durable, committed, answered with a lost connection;
 *   'in-progress'  neither committed nor aborted yet: its row locks stay held and its status reads `in progress`;
 *   or { mode, error, before } where `before` runs before the COMMIT is decided.
 * A transaction without an XID commits as itself. `statusReads` answers each status read in turn ('throw', 'null' or an
 * async function run before the real answer); `tokenFails` fails the next id requests.
 *
 * The double answers the ledger's SQL functions and the test-owned table `syn_effect` by what they do. It is a model of
 * the database, not an expectation of the product's statements: nothing here asserts which SQL the product sends, and an
 * unmodelled statement is an error so that a test never passes on an unanswered query.
 */
const { randomUUID } = require('node:crypto');

const text = strings => Array.isArray(strings) ? strings.join('$') : String(strings);
const alias = sql => (/\bAS\s+("?)(\w+)\1\s*$/i.exec(sql.trim()) || [])[2] || 'value';

class PgTxDouble {
  constructor({ firstXid = '1000' } = {}) {
    this.nextXid = BigInt(firstXid);
    this.clog = new Map();
    this.ops = new Map();
    this.identities = new Map();
    this.effects = new Map();
    this.plans = [];
    this.statusReads = [];
    this.tokenFails = 0;
    this.options = [];
    this.log = [];
    this.locked = new Set();
    this.txCount = 0;
    this.models = [];
  }
  plan(...entries) { this.plans.push(...entries); return this; }
  /** A suite's own table: handler(tx, values) answers a matching statement; tx.assign() gives the transaction its XID
   * (a write) and tx.onCommit(fn) runs fn only if that transaction commits. */
  model(pattern, handler) { this.models.push({ pattern, handler }); return this; }
  status(token) { return this.clog.has(token) ? this.clog.get(token) : null; }
  operation(id) { return this.ops.get(id) ?? null; }
  /** Status reads the product made, in order: the token it asked about and the transaction it asked from. */
  get judged() { return this.log.filter(e => e.kind === 'status'); }

  async $transaction(fn, options) {
    const tx = new Tx(this, ++this.txCount);
    this.options.push(options);
    this.log.push({ kind: 'begin', tx: tx.id, options });
    let value;
    try { value = await fn(tx.client); }
    catch (error) { tx.end('aborted'); this.log.push({ kind: 'rollback', tx: tx.id, xid: tx.xid }); throw error; }
    return tx.finish(value);
  }
  /** Statements outside a transaction (B2 admission) commit at once. */
  async $queryRaw(strings, ...values) {
    const tx = new Tx(this, ++this.txCount);
    const rows = await tx.statement(text(strings), values);
    tx.finishNow();
    return rows;
  }
  async $executeRaw(strings, ...values) { await this.$queryRaw(strings, ...values); return 0; }
}

class Tx {
  constructor(db, id) {
    Object.assign(this, { db, id, xid: null, staged: new Map(), identities: new Map(), effects: new Map(), queried: false, locks: new Set(),
      commits: [] });
    const run = async (strings, values) => this.statement(text(strings), values);
    this.client = {
      $queryRaw: (strings, ...values) => run(strings, values),
      $executeRaw: async (strings, ...values) => { await run(strings, values); return 0; },
      $queryRawUnsafe: (sql, ...values) => run(sql, values),
      $executeRawUnsafe: async (sql, ...values) => { await run(sql, values); return 0; },
    };
  }
  assign() { if (this.xid === null) this.xid = String(this.db.nextXid++); this.db.clog.set(this.xid, 'in progress'); }
  view(id) { return this.staged.has(id) ? this.staged.get(id) : this.db.ops.get(id) ?? null; }
  lockOperation(id) {
    if (this.db.locked.has(id) && !this.locks.has(id))
      throw Object.assign(new Error('canceling statement due to lock timeout'), { code: 'P2010', meta: { code: '55P03' } });
    this.locks.add(id); this.assign();
  }
  result(id) {
    const op = this.view(id);
    return op && { operationId: op.operationId, eventId: op.eventId, outcome: op.outcome, durableAt: op.durableAt,
      result: op.result, entries: op.entries };
  }
  async statement(sql, values) {
    this.db.log.push({ kind: 'statement', tx: this.id, sql });
    if (/^\s*SET\s+TRANSACTION\b/i.test(sql)) {
      if (this.queried) throw Object.assign(new Error('SET TRANSACTION ISOLATION LEVEL must be called before any query'),
        { code: 'P2010', meta: { code: '25001' } });
      return [];
    }
    if (/^\s*SET\s+LOCAL\b/i.test(sql)) return [];
    this.queried = true;
    const name = alias(sql);
    if (/pg_current_xact_id\s*\(/.test(sql)) {
      if (this.db.tokenFails > 0) { this.db.tokenFails--; throw new Error('SYN token query failed'); }
      this.assign();
      return [{ [name]: this.xid }];
    }
    if (/pg_xact_status\s*\(/.test(sql)) {
      const token = values[0];
      this.db.log.push({ kind: 'status', tx: this.id, token });
      const step = this.db.statusReads.shift();
      if (step === 'throw') throw Object.assign(new Error('SYN status read failed'), { code: 'P1017' });
      if (step === 'null') return [{ [name]: null }];
      if (typeof step === 'function') await step(token);
      return [{ [name]: typeof token === 'string' ? this.db.status(token) : null }];
    }
    if (/emr_access\.admit_operation\s*\(/.test(sql)) {
      // One event is one operation: a retry with other keys joins the operation admitted first.
      const [operationId, , payload] = values, eventId = JSON.parse(payload).eventId;
      const existing = [...this.db.ops.values()].find(op => op.eventId === eventId);
      if (existing) return [{ [name]: existing.operationId }];
      this.db.ops.set(operationId, { operationId, eventId, outcome: 'pending', durableAt: null, result: null, entries: [] });
      return [{ [name]: operationId }];
    }
    if (/emr_access\.lock_operation\s*\(/.test(sql)) {
      this.lockOperation(values[0]);
      return [{ [name]: this.view(values[0])?.outcome ?? 'missing' }];
    }
    if (/emr_access\.append_operation\s*\(/.test(sql)) {
      const [operationId, attemptId, , , kind, id, version] = values;
      this.lockOperation(operationId);
      const op = this.view(operationId);
      this.staged.set(operationId, { ...op, outcome: 'committed', durableAt: new Date().toISOString(),
        result: kind === null ? null : { kind, id, version },
        entries: [{ entryId: randomUUID(), stream: 'access', attemptId, expired: false },
          { entryId: randomUUID(), stream: 'history', attemptId, expired: false }] });
      return [{ [name]: null }];
    }
    if (/emr_access\.settle_operation\s*\(/.test(sql)) {
      const id = values[0];
      this.lockOperation(id);
      const op = this.view(id);
      if (op && op.outcome === 'pending') this.staged.set(id, { ...op, outcome: 'negative', durableAt: new Date().toISOString() });
      return [{ [name]: this.result(id) }];
    }
    if (/emr_access\.operation_result\s*\(/.test(sql)) return [{ [name]: this.result(values[0]) }];
    if (/emr_access\.record_projection\s*\(/.test(sql)) { this.assign(); return [{ [name]: '' }]; }
    if (/emr_access\.pending_operations\s*\(/.test(sql))
      return [...this.db.ops.values()].filter(op => op.outcome === 'pending').map(op => ({ operation_id: op.operationId }));
    if (/emr_access\.resolve_member_identity\s*\(/.test(sql)) {
      const key = JSON.stringify(values.slice(0, 2));
      const id = this.identities.get(key) ?? this.db.identities.get(key) ?? randomUUID();
      if (!this.db.identities.has(key)) { this.identities.set(key, id); this.assign(); }
      return [{ [name]: id }];
    }
    if (/\bsyn_effect\b/.test(sql) && /^\s*INSERT\b/i.test(sql)) {
      this.effects.set(values[0], values[1] ?? 1); this.assign();
      return [];
    }
    const own = this.db.models.find(m => m.pattern.test(sql));
    if (own) return (await own.handler({ assign: () => this.assign(), onCommit: fn => this.commits.push(fn) }, values)) ?? [];
    throw new Error('PgTxDouble: unmodelled statement ' + sql);
  }
  end(state) {
    if (this.xid !== null) this.db.clog.set(this.xid, state);
    if (state === 'committed') {
      for (const [id, op] of this.staged) this.db.ops.set(id, op);
      for (const [key, id] of this.identities) this.db.identities.set(key, id);
      for (const [key, value] of this.effects) this.db.effects.set(key, value);
      for (const fn of this.commits) fn();
    }
  }
  finishNow() { this.end('committed'); }
  async finish(value) {
    const raw = this.xid === null ? 'commit' : this.db.plans.shift() ?? 'commit';
    const step = typeof raw === 'string' ? { mode: raw } : raw;
    if (step.before) await step.before(this);
    this.db.log.push({ kind: 'commit', tx: this.id, xid: this.xid, mode: step.mode });
    if (step.mode === 'commit') { this.end('committed'); return value; }
    if (step.mode === 'silent-abort') { this.end('aborted'); return value; }
    if (step.mode === 'abort') { this.end('aborted'); throw step.error ?? new Error('SYN COMMIT refused'); }
    if (step.mode === 'lost') { this.end('committed'); throw Object.assign(new Error('SYN connection lost after COMMIT'), { code: 'P1017' }); }
    if (step.mode === 'in-progress') {
      for (const id of this.locks) this.db.locked.add(id);
      this.db.pending = { tx: this, settle: state => { for (const id of this.locks) this.db.locked.delete(id); this.end(state); } };
      throw Object.assign(new Error('SYN connection lost during COMMIT'), { code: 'P1017' });
    }
    throw new Error('PgTxDouble: unknown plan ' + step.mode);
  }
}

module.exports = { PgTxDouble };
