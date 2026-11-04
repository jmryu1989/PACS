'use strict';
/* MIP-OUTPUT-02: the API's connections to Orthanc (api/src/orthanc-transport.ts) against a real node:http server on
 * 127.0.0.1 that answers the Keep-Alive hint Orthanc sends and counts the TCP connections it accepts. Asserted, as the
 * server sees them: a 1 s hint (Orthanc's default) costs one connection per request even through the pool, a 5 s hint
 * (config/orthanc.json) lets sequential and concurrent reads reuse a bounded set; the two lanes together never exceed
 * their bound; image relays that keep Orthanc's answer open while their delivery record re-reads the study's revision
 * finish when they fill the whole body lane (the re-reads still get connections); a stopped and restarted archive fails
 * the reads in between visibly and serves the next ones; a waiting request follows its caller's abort and is never sent;
 * a full lane refuses at once in fetch's own failure shape. No DB, credentials or external network.
 */
require('./service_test_loader.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { Logger } = require('/app/node_modules/@nestjs/common');
const { orthancFetch } = require('/app/dist/orthanc-transport');
const { OrthancService } = require('/app/dist/orthanc.service');

const STUDY = '1.2.826.0.1.3680043.8.498.1';
const STUDY_ID = 'aaaaaaaa-bbbbbbbb-cccccccc-dddddddd-eeeeeeee';

/** A synthetic archive: `hint` seconds of keep-alive, every accepted socket and its request paths recorded. */
async function archive(t, hint, handle) {
  const sockets = [], live = new Set();
  const server = http.createServer((req, res) => {
    req.socket.paths.push(req.url);
    handle(req, res);
  });
  server.keepAliveTimeout = hint * 1000;
  server.on('connection', socket => { socket.paths = []; sockets.push(socket); live.add(socket); socket.on('close', () => live.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { server, sockets, live, origin };
}
const json = (res, value) => { const body = JSON.stringify(value); res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }); res.end(body); };
const read = async (origin, path, lane, init = {}) => { const response = await orthancFetch(origin + path, init, lane); return [response.status, await response.text()]; };
const until = async (condition, ms = 5000) => {
  const end = Date.now() + ms;
  while (!condition()) { if (Date.now() > end) throw new Error('condition not reached'); await new Promise(resolve => setTimeout(resolve, 5)); }
};

test('a 1 s hint costs a connection per request, a 5 s hint is reused within a bounded set', async t => {
  for (const [hint, lane] of [[1, 'check'], [5, 'check'], [5, 'body']]) {
    const { sockets, origin } = await archive(t, hint, (req, res) => json(res, { path: req.url }));
    for (let i = 0; i < 40; i++) assert.deepEqual(await read(origin, '/system?' + i, lane), [200, JSON.stringify({ path: '/system?' + i })]);
    if (hint === 1) assert.equal(sockets.length, 40, 'Orthanc 1.12.5 default: the 1 s hint is below the client threshold');
    // A request sent while the previous one's connection has not yet reported itself free may take a second one.
    else assert.ok(sockets.length <= 2, `${sockets.length} connections for 40 sequential ${lane} reads`);
    if (hint === 5) {
      // Concurrent whole reads: no more connections than the lane holds, all answered.
      const answers = await Promise.all(Array.from({ length: 50 }, (_, i) => read(origin, '/c?' + i, lane)));
      assert.ok(answers.every(([status], i) => status === 200 && answers[i][1].includes('/c?' + i)));
      assert.ok(sockets.length <= 8, `${sockets.length} connections for 50 concurrent ${lane} reads`);
    }
  }
  // The hint itself, as the archive sends it.
  const { origin } = await archive(t, 5, (req, res) => json(res, {}));
  const response = await orthancFetch(origin + '/system', {}, 'check'); await response.arrayBuffer();
  assert.equal(response.headers.get('keep-alive'), 'timeout=5');
});

test('the two lanes together never exceed their bound and never share a connection', async t => {
  let open = 0, peak = 0;
  const held = [];
  const { sockets, origin } = await archive(t, 5, (req, res) => {
    open++; peak = Math.max(peak, open); res.on('close', () => open--);
    held.push(() => json(res, { path: req.url }));
  });
  const reads = [...Array.from({ length: 30 }, (_, i) => read(origin, '/check?' + i, 'check')),
    ...Array.from({ length: 30 }, (_, i) => read(origin, '/body?' + i, 'body'))];
  await until(() => held.length === 16);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(held.length, 16, 'the 61st..: requests wait for a connection of their own lane');
  const pump = setInterval(() => { while (held.length) held.shift()(); }, 2);
  try { assert.ok((await Promise.all(reads)).every(([status]) => status === 200)); } finally { clearInterval(pump); }
  assert.equal(peak, 16);
  assert.ok(sockets.length <= 16, String(sockets.length));
  for (const socket of sockets) {
    const kinds = new Set(socket.paths.map(path => path.split('?')[0]));
    assert.equal(kinds.size, 1, 'a connection serves one lane: ' + [...kinds]);
  }
});

/** A RelayTarget (the Express response the image relay writes): status, headers, written bytes and its events. */
function target() {
  const sink = new EventEmitter();
  return Object.assign(sink, { code: 0, chunks: [], ended: false, destroyed: false,
    status(code) { this.code = code; }, setHeader() {}, write(chunk) { this.chunks.push(Buffer.from(chunk)); return true; },
    end() { this.ended = true; } });
}

test('relays holding every body connection still finish: their delivery records re-read the study on the check lane', async t => {
  const warnings = [], warn = Logger.prototype.warn;
  Logger.prototype.warn = function (message) { warnings.push(message); };
  t.after(() => { Logger.prototype.warn = warn; });
  const held = [];
  let openFiles = 0, checksWhileFull = 0;
  const { sockets, origin } = await archive(t, 5, (req, res) => {
    if (req.url.startsWith('/instances/')) {
      // The image answer starts (Orthanc has chosen it) and stays open until the test releases it.
      openFiles++; res.on('close', () => openFiles--);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': '4' }); res.write('ab');
      held.push(() => res.end('cd'));
      return;
    }
    if (openFiles === 8) checksWhileFull++;
    let body = '';
    req.on('data', part => { body += part; });
    req.on('end', () => {
      if (req.url === '/tools/lookup') return json(res, body === STUDY ? [{ Type: 'Study', ID: STUDY_ID }] : []);
      if (req.url === '/studies/' + STUDY_ID) return json(res, { LastUpdate: '20261104T120000' });
      res.writeHead(404); res.end();
    });
  });
  process.env.ORTHANC_USER = 'synthetic'; process.env.ORTHANC_PASS = 'synthetic';
  const orthanc = new OrthancService(); orthanc.base = origin;
  let confirmed = 0;
  // image-relay.controller.ts: selected() is the delivery lease's confirm, which reads the archive's study revision.
  const selected = async () => { await orthanc.studyRevision(STUDY); confirmed++; return true; };
  const targets = Array.from({ length: 12 }, target);
  const relays = targets.map((sink, i) => orthanc.relay(`/instances/${i}/file`, '*/*', sink, undefined, undefined, selected));
  await until(() => held.length === 8 && confirmed === 8);
  assert.equal(openFiles, 8, 'the body lane is full');
  // At least the last of the eight confirmed (lookup + study) while all eight answers were open.
  assert.ok(checksWhileFull >= 2, `the study re-reads were served while the body lane was full (${checksWhileFull})`);
  const pump = setInterval(() => { while (held.length) held.shift()(); }, 2);
  try { await Promise.all(relays); } finally { clearInterval(pump); }
  assert.equal(confirmed, 12);
  for (const sink of targets) assert.deepEqual([sink.code, Buffer.concat(sink.chunks).toString(), sink.ended], [200, 'abcd', true]);
  assert.deepEqual(warnings, []);
  assert.ok(sockets.filter(socket => socket.paths.some(path => path.startsWith('/instances/'))).length <= 8);
});

test('a stopped archive fails the reads visibly, a restarted one serves the next read on a new connection', async t => {
  const warnings = [], warn = Logger.prototype.warn;
  Logger.prototype.warn = function (message) { warnings.push(message); };
  t.after(() => { Logger.prototype.warn = warn; });
  const first = await archive(t, 5, (req, res) => json(res, [{ '0020000D': { Value: [STUDY] } }]));
  const port = first.server.address().port;
  process.env.ORTHANC_USER = 'synthetic'; process.env.ORTHANC_PASS = 'synthetic';
  const orthanc = new OrthancService(); orthanc.base = first.origin;
  assert.equal((await orthanc.reportPreviewStudy(STUDY))['0020000D'].Value[0], STUDY);
  assert.equal(first.live.size, 1, 'the read left its connection in the pool');
  // Orthanc stops: its open connections close under the pool.
  first.server.closeAllConnections(); await new Promise(resolve => first.server.close(resolve));
  await until(() => first.live.size === 0);
  await assert.rejects(orthanc.reportPreviewStudy(STUDY), error => error.getStatus() === 503);
  assert.equal(warnings.at(-1), 'viewer_source category=transport', 'the failure is reported, not silent');
  await assert.rejects(orthancFetch(first.origin + '/system', {}, 'body'), error => error instanceof TypeError);
  // Orthanc is back on the same address.
  const sockets = [];
  const again = http.createServer((req, res) => json(res, [{ '0020000D': { Value: [STUDY] } }]));
  again.keepAliveTimeout = 5000; again.on('connection', socket => sockets.push(socket));
  await new Promise(resolve => again.listen(port, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { again.closeAllConnections(); again.close(() => resolve()); }));
  for (let i = 0; i < 5; i++) assert.equal((await orthanc.reportPreviewStudy(STUDY))['0020000D'].Value[0], STUDY);
  assert.deepEqual(await read(first.origin, '/system', 'body'), [200, JSON.stringify([{ '0020000D': { Value: [STUDY] } }])]);
  const reconnected = sockets.length;
  assert.ok(reconnected >= 2 && reconnected <= 4, `${reconnected} new connections after the restart`);
  // A connection the archive drops while idle (a restart between two reads) is replaced, not reused.
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await orthanc.reportPreviewStudy(STUDY))['0020000D'].Value[0], STUDY);
  assert.equal(sockets.length, reconnected + 1);
  assert.equal(warnings.filter(w => w === 'viewer_source category=transport').length, 1);
});

test('a waiting request follows its abort and is never sent; a full lane refuses at once', async t => {
  const held = [], received = [];
  const { origin } = await archive(t, 5, (req, res) => { received.push(req.url); held.push(() => json(res, {})); });
  const running = Array.from({ length: 8 }, (_, i) => read(origin, '/held?' + i, 'check'));
  await until(() => held.length === 8);
  const controller = new AbortController();
  const waiting = orthancFetch(origin + '/aborted', { signal: controller.signal }, 'check');
  setTimeout(() => controller.abort(), 30);
  const started = Date.now();
  await assert.rejects(waiting, error => error.name === 'AbortError');
  assert.ok(Date.now() - started < 1000, 'the abort ends the wait, not a free connection');
  // Fill the queue until the lane refuses.
  const queued = [];
  let refusal;
  for (let i = 0; i < 5000 && !refusal; i++) {
    const request = orthancFetch(origin + '/queued?' + i, {}, 'check');
    const outcome = await Promise.race([request.then(() => 'answered', error => error), new Promise(resolve => setImmediate(() => resolve('waiting')))]);
    if (outcome === 'waiting') queued.push(request); else refusal = outcome;
  }
  assert.ok(refusal instanceof TypeError, 'a full lane refuses');
  assert.equal(refusal.cause?.code, 'KIN_ORTHANC_BUSY');
  assert.ok(queued.length >= 100, `${queued.length} requests waited before the refusal`);
  const pump = setInterval(() => { while (held.length) held.shift()(); }, 1);
  try {
    await Promise.all(running);
    const answered = await Promise.all(queued.map(request => request.then(response => response.arrayBuffer().then(() => response.status))));
    assert.ok(answered.every(status => status === 200));
  } finally { clearInterval(pump); }
  assert.ok(!received.includes('/aborted'), 'the aborted request never reached the archive');
  assert.equal(received.length, 8 + queued.length);
});
