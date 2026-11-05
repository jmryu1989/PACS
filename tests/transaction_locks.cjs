'use strict';
// Transaction-owned advisory locks for service doubles. PostgreSQL scheduling,
// hash mapping and row lock interactions are checked by the PG boundary suite.
class TransactionLocks {
  holders = new Map();
  waiters = new Map();
  async acquire(owner, key) {
    if (!owner) throw new Error('transaction lock requires a transaction');
    while (this.holders.has(key) && this.holders.get(key) !== owner) {
      await new Promise(resolve => {
        const queue = this.waiters.get(key) ?? [];
        queue.push(resolve); this.waiters.set(key, queue);
      });
    }
    this.holders.set(key, owner);
  }
  release(owner) {
    for (const [key, held] of this.holders) if (held === owner) {
      this.holders.delete(key);
      const queue = this.waiters.get(key) ?? [];
      this.waiters.delete(key);
      for (const resolve of queue) resolve();
    }
  }
}
// The fixed-record key text api/src/emr-runtime/fixed-record-lock.ts passes for `recordId`.
const fixedRecord = recordId => JSON.stringify(['emr-fixed-record', recordId]);
// That key when a raw query is the fixed-record lock, else null: any other advisory
// lock still falls through to the double's own refusal of an unknown query.
function fixedRecordKey(strings, values) {
  return strings.join('?').includes('pg_advisory_xact_lock') && typeof values[0] === 'string'
    && values[0].startsWith('["emr-fixed-record",') ? values[0] : null;
}
module.exports = { TransactionLocks, fixedRecord, fixedRecordKey };
