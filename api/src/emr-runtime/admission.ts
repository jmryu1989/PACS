/** The chain head already serializes all append transactions. Queue before
 * opening a connection, not while holding a pool slot behind that row lock.
 * One admission lane per PrismaClient is shared by all stores using that pool.
 * Release at COMMIT/ROLLBACK, before receipt verification: verification must
 * never depend on a later request releasing the admission lane.
 */
const lanes = new WeakMap<object, Promise<void>>();
export async function admitAppend<T>(client: object, work: () => Promise<T>): Promise<T> {
  const before = lanes.get(client) ?? Promise.resolve();
  let release: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  lanes.set(client, current);
  await before;
  try { return await work(); }
  finally {
    release();
    if (lanes.get(client) === current) lanes.delete(client);
  }
}
