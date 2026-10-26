'use strict';
// E_ROUTE study deliveries (api/src/emr-image/delivery.ts): one access record per requester, session and manifest
// version for a continuous viewing, opened once for a burst of simultaneous frames, closed after an idle period, after
// its bounded age, when a response finds the facts changed, and at shutdown; the terminal event follows what E observed.
// Compiled product code; the hooks that write B2 are stand-ins recording their calls.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const api = process.env.KIN_E_API || path.resolve(__dirname, '../../../api');
const load = name => require(path.join(api, 'dist', name));
const { ImageDeliveries, deliveryClosing } = load('emr-image/delivery');
const { createBackgroundWorkRegistry } = load('emr-runtime/background-work');

const live = () => new AbortController().signal;
const settle = () => new Promise(resolve => setImmediate(resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let serial = 0;
/** A deliveries instance whose hooks record every open and close; `opens` can be made to wait or fail per call. */
function harness(limits = { idleMs: 40, maxAgeMs: 10000 }, opts = {}) {
  const registry = createBackgroundWorkRegistry();
  const opened = [], closed = [];
  const hooks = {
    async open(key, opener) {
      if (opts.gate) await opts.gate();
      if (opener?.fail) throw opener.fail;
      const id = `delivery-${++serial}`;
      const delivery = { event: { eventId: id }, receipt: { eventId: id, durableAt: new Date().toISOString() }, prepared: { eventId: id }, facts: { key, opener } };
      opened.push({ key, opener, id });
      return delivery;
    },
    async close(delivery, outcome, closing) { closed.push({ id: delivery.event.eventId, outcome, closing }); },
  };
  return { deliveries: new ImageDeliveries(registry.work, hooks, limits), registry, opened, closed };
}

test('the terminal event follows what E observed on the responses', () => {
  const o = (ended, aborted, unknown) => ({ ended, aborted, unknown });
  assert.equal(deliveryClosing(o(200, 0, 0)), 'transfer-ended');
  assert.equal(deliveryClosing(o(199, 1, 0)), 'transfer-aborted');
  assert.equal(deliveryClosing(o(199, 0, 1)), null, 'an unconfirmed ending has no v1 access action');
  assert.equal(deliveryClosing(o(0, 1, 1)), 'transfer-aborted');
  assert.equal(deliveryClosing(o(0, 0, 0)), 'transfer-aborted', 'nothing transferred is not an ended transfer');
});

test('a burst of simultaneous frames of one requester is one record, closed once after they end', async () => {
  const h = harness();
  const leases = await Promise.all(Array.from({ length: 50 }, () => h.deliveries.join('k1', { n: 1 }, live())));
  assert.equal(h.opened.length, 1, 'one provide-prepared record for the burst');
  assert.ok(leases.every(l => l.delivery.event.eventId === h.opened[0].id));
  for (const lease of leases) lease.end('transfer-ended', 1000);
  assert.equal(h.closed.length, 0, 'the record stays open for the next frames');
  const again = await h.deliveries.join('k1', { n: 2 }, live());
  assert.equal(again.delivery.event.eventId, h.opened[0].id, 'a frame within the idle window joins the open record');
  again.end('transfer-ended', 10);
  await sleep(120);
  assert.equal(h.closed.length, 1);
  assert.equal(h.closed[0].closing, 'transfer-ended');
  assert.deepEqual([h.closed[0].outcome.responses, h.closed[0].outcome.ended, h.closed[0].outcome.bytesWritten], [51, 51, 50010]);
  assert.deepEqual(h.closed[0].outcome.unstored, [], 'every response stored its own rows');
  // After the idle close the next frame opens a new record.
  const later = await h.deliveries.join('k1', { n: 3 }, live());
  assert.notEqual(later.delivery.event.eventId, h.opened[0].id);
  assert.equal(h.opened.length, 2);
  later.end('transfer-aborted', 5);
  await sleep(120);
  assert.equal(h.closed[1].closing, 'transfer-aborted');
});

test('rows the store refused on a response reach the close hook with the terminal choice unchanged', async () => {
  // R244-GPT-02: the response ended; what failed is the retention of its facts. The delivery keeps them for its own
  // closing transaction instead of dropping them with the response's result.
  const h = harness();
  const refusedTransport = { kind: 'transport', link: { eventId: 'r1', deliveryEventId: 'd', requestId: 'q1' }, body: { observations: [], wire: { bytesWritten: 9, plannedBytes: 9, terminal: 'transfer-ended' } }, error: new Error('synthetic pool failure') };
  const refusedCopies = { kind: 'copies', link: { eventId: 'r2', deliveryEventId: 'd', requestId: 'q2' }, body: [], error: new Error('synthetic pool failure') };
  const [a, b, c] = await Promise.all([h.deliveries.join('k', {}, live()), h.deliveries.join('k', {}, live()), h.deliveries.join('k', {}, live())]);
  a.end('transfer-ended', 9, [refusedTransport]); b.end('transfer-ended', 9); c.end('not-sent', 0, [refusedCopies]);
  await sleep(120);
  assert.equal(h.closed.length, 1);
  assert.equal(h.closed[0].closing, 'transfer-ended', 'the transfers ended; only their retention is late');
  assert.deepEqual(h.closed[0].outcome.unstored, [refusedTransport, refusedCopies]);
  assert.deepEqual([h.closed[0].outcome.responses, h.closed[0].outcome.ended, h.closed[0].outcome.notSent], [3, 2, 1]);
});

test('another requester, session or manifest version is another record; an unconfirmed ending closes without a v1 action', async () => {
  const h = harness();
  const [a, b] = await Promise.all([h.deliveries.join('doctor|session-1|manifest-A', {}, live()), h.deliveries.join('doctor|session-2|manifest-A', {}, live())]);
  const c = await h.deliveries.join('doctor|session-1|manifest-B', {}, live());
  assert.equal(new Set([a, b, c].map(l => l.delivery.event.eventId)).size, 3);
  a.end('transfer-ended', 1); b.end('transfer-unknown', 1); c.end('not-sent', 0);
  await sleep(120);
  const byId = Object.fromEntries(h.closed.map(x => [x.id, x]));
  assert.equal(byId[a.delivery.event.eventId].closing, 'transfer-ended');
  assert.equal(byId[b.delivery.event.eventId].closing, null);
  assert.equal(byId[c.delivery.event.eventId].closing, 'transfer-aborted');
  assert.equal(byId[c.delivery.event.eventId].outcome.notSent, 1);
});

test('a retired record takes no later frame and closes when its responses end; a bounded age reopens', async () => {
  const h = harness({ idleMs: 40, maxAgeMs: 60 });
  const first = await h.deliveries.join('k', {}, live());
  const second = await h.deliveries.join('k', {}, live());
  assert.equal(first.delivery.event.eventId, second.delivery.event.eventId);
  first.retire();
  const third = await h.deliveries.join('k', {}, live());
  assert.notEqual(third.delivery.event.eventId, first.delivery.event.eventId, 'changed facts: the next frame has a new record');
  assert.equal(h.closed.length, 0, 'the retired record waits for its response in flight');
  first.end('not-sent', 0); second.end('transfer-ended', 7);
  await settle();
  assert.equal(h.closed.length, 1);
  assert.equal(h.closed[0].id, first.delivery.event.eventId);
  await sleep(80);
  const aged = await h.deliveries.join('k', {}, live());
  assert.notEqual(aged.delivery.event.eventId, third.delivery.event.eventId, 'past its age the record is replaced');
  third.end('transfer-ended', 1); aged.end('transfer-ended', 1);
  await sleep(100);
  assert.equal(h.closed.length, 3);
});

test('an opening that fails for its own requester does not decide a joined request; an aborted joiner stops waiting', async () => {
  let release;
  const gate = () => new Promise(resolve => { release = resolve; });
  const h = harness(undefined, { gate });
  const own = h.deliveries.join('k', { fail: new Error('synthetic refusal of the first requester') }, live());
  await settle();
  const joined = h.deliveries.join('k', {}, live());
  const control = new AbortController();
  const waiter = h.deliveries.join('k', {}, control.signal);
  control.abort(new Error('synthetic client abort'));
  await assert.rejects(waiter, /synthetic client abort/);
  release();
  await assert.rejects(own, /synthetic refusal/);
  await settle(); release();
  const lease = await joined;
  assert.equal(h.opened.length, 1, 'the joined request opened its own record (the failed opening recorded none)');
  assert.equal(lease.delivery.facts.opener.fail, undefined);
  lease.end('transfer-ended', 1);
  await sleep(100);
  assert.equal(h.closed.length, 1);
});

test('at shutdown idle records close now, one in flight closes when its response ends, and no new record opens', async () => {
  const h = harness({ idleMs: 5000, maxAgeMs: 60000 });
  const idle = await h.deliveries.join('idle', {}, live());
  idle.end('transfer-ended', 1);
  const busy = await h.deliveries.join('busy', {}, live());
  h.registry.quiesce();
  await h.deliveries.closeAll();
  assert.deepEqual(h.closed.map(x => x.id), [idle.delivery.event.eventId]);
  await assert.rejects(h.deliveries.join('new', {}, live()), { code: 'ImageDeliveryStopping' });
  busy.end('transfer-ended', 1);
  await settle();
  assert.deepEqual(h.closed.map(x => x.id), [idle.delivery.event.eventId, busy.delivery.event.eventId]);
  await h.registry.drained();
});

test('a quiesced background registry closes an idle record at once instead of waiting for a timer it cannot own', async () => {
  const h = harness({ idleMs: 5000, maxAgeMs: 60000 });
  const lease = await h.deliveries.join('k', {}, live());
  h.registry.quiesce();
  lease.end('transfer-ended', 1);
  await settle();
  assert.equal(h.closed.length, 1);
});
