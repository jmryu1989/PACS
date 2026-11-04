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
module.exports = { TransactionLocks };
