'use strict';

/* REQUEST_FACTS order RF-1/RF-2/RF-5 -> misattribution, lost ingress, late publication.
 * Test the production admission/transport boundary, not its source spelling.
 * Pure lifecycle checks support, but do not replace, real Guard/PG/HTTP evidence.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { IncomingMessage, ServerResponse } = require('node:http');
const { Socket } = require('node:net');
const { lookup } = require('node:dns/promises');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const root = path.resolve(__dirname, '../../..');
const ts = Module.createRequire(path.join(root, 'api/package.json'))('typescript');
const compiled = new Map();
function load(filename) {
  if (compiled.has(filename)) return compiled.get(filename).exports;
  const result = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
    fileName: filename,
  });
  const unit = new Module(filename, module);
  unit.filename = filename;
  unit.require = specifier => specifier.startsWith('.')
    ? load(path.resolve(path.dirname(filename), specifier + '.ts')) : require(specifier);
  compiled.set(filename, unit);
  unit._compile(result.outputText, filename);
  return unit.exports;
}
const { createRequestContext, RequestContextUnavailable } = load(path.join(root, 'api/src/emr-runtime/request-context.ts'));
const { createRequestIngress, observeRequestIngress } = load(path.join(root, 'api/src/emr-runtime/request-ingress.ts'));
const { createRecordPort } = load(path.join(root, 'api/src/emr-runtime/record-port.ts'));
const unknown = { status: 'unresolved', reason: 'not-observed' };
const known = address => ({ status: 'known', value: { address, source: 'trusted-proxy' } });
const route = () => ({ method: 'GET', route: '/api/studies/:uid/report/versions', purpose: 'clinical' });
const admission = () => ({
  issuer: 'https://oidc.example/realm/first', subject: 'member-1', roles: ['radiologist'],
  institution: 'first-site', rightsVersion: 7,
  binding: { method: 'session', sessionRef: 'existing-session-ref' },
});
function transport(peer = '192.0.2.10', rawHeaders = ['X-Real-IP', '198.51.100.25']) {
  const socket = new Socket();
  Object.defineProperty(socket, 'remoteAddress', { value: peer });
  const request = new IncomingMessage(socket);
  request.rawHeaders = [...rawHeaders];
  return { request, response: new ServerResponse(request) };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function context(resolvePeer, port) {
  return createRequestContext(createRequestIngress({ proxyPeers: ['proxy.test'] }, resolvePeer), port);
}
const proxyAnswer = [{ address: '192.0.2.10', family: 4 }];

test('RF-3 current authorization also gates protected conflict response bodies', async () => {
  require('../../service_test_loader.cjs');
  const {PacsController} = require(path.join(root,'api/src/pacs.controller.ts'));
  const {AdminController} = require(path.join(root,'api/src/admin.controller.ts'));
  const {ConflictException,UnauthorizedException} = require(path.join(root,'api/node_modules/@nestjs/common'));
  for (const boundary of ['draft','admin']) {
    let current=true;
    const port={begin:()=>({resolveRequestIdentity:async()=> '00000000-0000-4000-8000-000000000001',end(){}})};
    const ctx=context(async()=>proxyAnswer,port), {request,response}=transport();
    Object.assign(request,{sub:'member-1',actor:'synthetic-reader',roles:['radiologist'],institution:'first-site'});
    ctx.capture.capture(request,response,admission(),route(),async()=>{
      if(!current)throw new UnauthorizedException('요청을 시작한 세션이 종료되었습니다');
    });
    const refuse=async()=>{current=false;throw new ConflictException({snapshot:{findings:'private synthetic draft'}});};
    const pending=boundary==='draft'
      ? new PacsController({readDraft:refuse},null,ctx.source).draft('synthetic-study',request)
      : new AdminController({patchUser:refuse},null,ctx.source).patch('synthetic-member',{},request);
    await assert.rejects(pending,error=>error.getStatus()===401 && !error.getResponse().snapshot);
    response.emit('finish');
  }
});

test('RF-1 admission is copied and frozen; request decoration/credentials do not enter it', async () => {
  const ctx = context(async () => proxyAnswer), { request, response } = transport();
  const verified = admission(), serverRoute = route();
  Object.assign(request, { user: { subject: 'unrelated' }, institution: 'other-site', requestId: 'client-id',
    body: { issuer: 'body-issuer', subject: 'body-subject' }, sid: 'raw-sid' });
  request.headers = { cookie: 'raw-cookie', authorization: 'Bearer raw-token', 'x-request-id': 'client-id' };
  Object.assign(verified, { accessToken: 'raw-token', sid: 'raw-sid', displayName: 'Shared Name' });
  ctx.capture.capture(request, response, verified, serverRoute);
  const captured = ctx.source.read(request);
  assert.deepEqual(captured, { ...admission(), requestId: captured.requestId, route: route() });
  assert.match(captured.requestId, /^[0-9a-f-]{36}$/);
  verified.roles.push('admin'); verified.subject = 'changed'; verified.binding.sessionRef = 'replacement-session';
  serverRoute.route = '/changed'; request.rawHeaders[1] = '203.0.113.9';
  request.user.subject = 'changed-again';
  assert.equal(ctx.source.read(request), captured);
  assert.deepEqual(captured.roles, ['radiologist']);
  assert.equal(captured.binding.sessionRef, 'existing-session-ref');
  assert.equal(captured.route.route, route().route);
  for (const part of [captured, captured.roles, captured.binding, captured.route]) assert(Object.isFrozen(part));
  assert.throws(() => { captured.roles.push('admin'); }, TypeError);
  assert.deepEqual(await ctx.source.ingress(request), known('198.51.100.25'));
  response.emit('finish');
});

test('RF-1 duplicate capture preserves first admission and correlation; bearer binding remains null', () => {
  const ctx = context(async () => proxyAnswer), { request, response } = transport();
  const bearer = { ...admission(), binding: { method: 'bearer', sessionRef: null } };
  ctx.capture.capture(request, response, bearer, route());
  const first = ctx.source.read(request);
  ctx.capture.capture(request, response, admission(), { ...route(), purpose: 'authentication' });
  assert.equal(ctx.source.read(request), first);
  assert.deepEqual(first.binding, { method: 'bearer', sessionRef: null });
  response.emit('finish');
});

test('RF-1 uncaptured requests have no member context (Guard exceptions require the live run)', async () => {
  const ctx = context(async () => proxyAnswer), { request } = transport();
  assert.throws(() => ctx.source.read(request), RequestContextUnavailable);
  await assert.rejects(ctx.source.ingress(request), RequestContextUnavailable);
});

test('RF-1 issuer-local subjects remain distinct; names are not captured identity keys', () => {
  const ctx = context(async () => proxyAnswer), first = transport(), second = transport();
  ctx.capture.capture(first.request, first.response, { ...admission(), displayName: 'Shared Name' }, route());
  ctx.capture.capture(second.request, second.response,
    { ...admission(), issuer: 'https://oidc.example/realm/second', displayName: 'Shared Name' }, route());
  const a = ctx.source.read(first.request), b = ctx.source.read(second.request);
  assert.equal(a.subject, b.subject);
  assert.notEqual(a.issuer, b.issuer);
  assert.notEqual(a.requestId, b.requestId);
  first.response.emit('finish'); second.response.emit('finish');
});

test('RF-2 lazy ingress shares one promise including lookup failure, without automatic retry', async () => {
  let calls = 0;
  const failure = new Error('proxy resolver unavailable');
  const ctx = context(async () => { calls++; throw failure; }), { request, response } = transport();
  ctx.capture.capture(request, response, admission(), route());
  assert.equal(calls, 0);
  const a = ctx.source.ingress(request), b = ctx.source.ingress(request);
  assert.equal(a, b);
  await assert.rejects(a, error => error === failure);
  assert.equal(ctx.source.ingress(request), a);
  await assert.rejects(b, error => error === failure);
  assert.equal(calls, 1);
  response.emit('finish');
});

test('RF-1/RF-2 interleaved requests retain separate snapshots and one lookup each', async () => {
  const lookups = [deferred(), deferred()]; let calls = 0;
  const ctx = context(() => lookups[calls++].promise);
  const first = transport(), second = transport('192.0.2.10', ['X-Real-IP', '203.0.113.20']);
  ctx.capture.capture(first.request, first.response, admission(), route());
  ctx.capture.capture(second.request, second.response, { ...admission(), subject: 'member-2' }, route());
  const a = ctx.source.ingress(first.request), b = ctx.source.ingress(second.request);
  assert.equal(ctx.source.ingress(first.request), a);
  await Promise.resolve();
  lookups[1].resolve(proxyAnswer);
  assert.deepEqual(await b, known('203.0.113.20'));
  lookups[0].resolve(proxyAnswer);
  assert.deepEqual(await a, known('198.51.100.25'));
  assert.equal(ctx.source.read(first.request).subject, 'member-1');
  assert.equal(ctx.source.read(second.request).subject, 'member-2');
  assert.equal(calls, 2);
  first.response.emit('finish'); second.response.emit('finish');
});

test('RF-2 absent/duplicate/invalid headers and direct peers remain unobserved; no XFF/Host fallback', async () => {
  const ingress = createRequestIngress({ proxyPeers: ['192.0.2.10'] });
  for (const headers of [[], ['X-Forwarded-For', '198.51.100.25', 'Host', '198.51.100.25'],
    ['X-Real-IP', ''], ['X-Real-IP', 'client.test'], ['X-Real-IP', '198.51.100.25, 203.0.113.20'],
    ['X-Real-IP', '198.51.100.25', 'x-real-ip', '198.51.100.25'], ['X-Real-IP']]) {
    const { request } = transport('192.0.2.10', headers);
    assert.deepEqual(await ingress.resolve(observeRequestIngress(request)), unknown, JSON.stringify(headers));
  }
  for (const peer of [undefined, '', 'direct.test', '192.0.2.20']) {
    const observation = { peer: peer ?? null, address: '198.51.100.25' };
    assert.deepEqual(await ingress.resolve(observation), unknown);
  }
  assert.deepEqual(await createRequestIngress({ proxyPeers: [] }).resolve({ peer: '127.0.0.1', address: '127.0.0.1' }), unknown);
});

test('RF-2 mapped IPv4 and equivalent IPv6 addresses match explicit deployment peers', async () => {
  const ingress = createRequestIngress({ proxyPeers: ['192.0.2.10', '2001:db8:1::10'] });
  for (const peer of ['::ffff:192.0.2.10', '::ffff:c000:20a', '2001:0DB8:0001:0:0:0:0:0010']) {
    const { request } = transport(peer, ['x-ReAl-Ip', '2001:db8:2::5']);
    assert.deepEqual(await ingress.resolve(observeRequestIngress(request)), known('2001:db8:2::5'));
  }
});

test('RF-2 empty deployment peers fail configuration and unusable observations do not trigger DNS', async () => {
  assert.throws(() => createRequestIngress({ proxyPeers: [' '] }), /Deployment proxy peer is empty/);
  let calls = 0;
  const ingress = createRequestIngress({ proxyPeers: ['proxy.test'] }, async () => { calls++; return proxyAnswer; });
  for (const observation of [{ peer: null, address: '198.51.100.25' }, { peer: '192.0.2.10', address: null }]) {
    assert.deepEqual(await ingress.resolve(observation), unknown);
  }
  assert.equal(calls, 0);
});

test('RF-2 proxy replacement is resolved afresh and a DNS error does not reuse old addresses', async () => {
  let address = '192.0.2.10', failed = false;
  const ingress = createRequestIngress({ proxyPeers: ['proxy.test'] }, async () => {
    if (failed) throw new Error('lookup failed');
    return [{ address, family: 4 }];
  });
  const old = { peer: '192.0.2.10', address: '198.51.100.25' };
  assert.deepEqual(await ingress.resolve(old), known(old.address));
  address = '192.0.2.11';
  assert.deepEqual(await ingress.resolve(old), unknown);
  const current = { ...old, peer: address };
  assert.deepEqual(await ingress.resolve(current), known(old.address));
  failed = true;
  await assert.rejects(ingress.resolve(current), /lookup failed/);
});

test('RF-2 default resolver uses normal OS lookup for explicitly configured localhost', async () => {
  const [peer] = await lookup('localhost', { all: true });
  assert(peer);
  const ingress = createRequestIngress({ proxyPeers: ['localhost'] });
  assert.deepEqual(await ingress.resolve({ peer: peer.address, address: '198.51.100.25' }), known('198.51.100.25'));
});

test('RF-5 receiving request end/ordinary close does not end the response context', async () => {
  const ctx = context(async () => proxyAnswer), { request, response } = transport();
  ctx.capture.capture(request, response, admission(), route());
  const first = ctx.source.read(request);
  request.emit('end'); request.emit('close');
  assert.equal(ctx.source.read(request), first);
  assert.deepEqual(await ctx.source.ingress(request), known('198.51.100.25'));
  response.emit('finish');
});

for (const [target, event] of [['response', 'finish'], ['response', 'close'], ['response', 'error'],
  ['request', 'aborted'], ['request', 'error']]) {
  test(`RF-5 ${target} ${event} immediately revokes source and duplicate capture cannot revive it`, async () => {
    const ctx = context(async () => proxyAnswer), pair = transport();
    ctx.capture.capture(pair.request, pair.response, admission(), route());
    await ctx.source.ingress(pair.request);
    pair[target].emit(event, new Error('transport ended'));
    assert.throws(() => ctx.source.read(pair.request), RequestContextUnavailable);
    ctx.capture.capture(pair.request, pair.response, admission(), route());
    await assert.rejects(ctx.source.ingress(pair.request), RequestContextUnavailable);
    pair.response.emit('finish'); pair.response.emit('close');
    assert.throws(() => ctx.source.read(pair.request), RequestContextUnavailable);
  });
}

test('RF-5 late lookup cannot revive a finished response or start another lookup', async () => {
  const pending = deferred(); let calls = 0;
  const ctx = context(() => { calls++; return pending.promise; }), { request, response } = transport();
  ctx.capture.capture(request, response, admission(), route());
  const observed = ctx.source.ingress(request);
  await Promise.resolve();
  response.emit('close');
  pending.resolve(proxyAnswer);
  await assert.rejects(observed, RequestContextUnavailable);
  await assert.rejects(ctx.source.ingress(request), RequestContextUnavailable);
  assert.equal(calls, 1);
});

test('RF-5 termination before deferred lookup starts performs no resolver work', async () => {
  let calls = 0;
  const ctx = context(async () => { calls++; return proxyAnswer; }), { request, response } = transport();
  ctx.capture.capture(request, response, admission(), route());
  const observed = ctx.source.ingress(request);
  request.emit('aborted');
  await assert.rejects(observed, RequestContextUnavailable);
  assert.equal(calls, 0);
});

test('RF-5 an already ended response or aborted request is never made active', () => {
  for (const state of ['aborted', 'ended', 'destroyed']) {
    const ctx = context(async () => proxyAnswer), { request, response } = transport();
    if (state === 'aborted') request.aborted = true;
    if (state === 'ended') response.end();
    if (state === 'destroyed') response.destroy();
    ctx.capture.capture(request, response, admission(), route());
    assert.throws(() => ctx.source.read(request), RequestContextUnavailable);
  }
});

test('RF-1 one lazy materialization and work per request, with failure cached', async () => {
  let resolves = 0;
  const failure = new Error('identity storage unavailable');
  const { port, control } = createRecordPort({ resolveRequestIdentity: async () => { resolves++; throw failure; } });
  const ctx = context(async () => proxyAnswer, port), { request, response } = transport();
  ctx.capture.capture(request, response, admission(), route(), async () => {});
  assert.equal(control.live(), 0);
  const first = ctx.source.facts(request);
  assert.equal(ctx.source.facts(request), first);
  await assert.rejects(first, error => error === failure);
  assert.equal(ctx.source.facts(request), first);
  await assert.rejects(ctx.source.facts(request), error => error === failure);
  assert.equal(resolves, 1);
  assert.equal(control.live(), 0);
  response.emit('finish');
});

test('RF-5 outstanding coordinator settles on original work after disconnect; no publication', async () => {
  const { port, control } = createRecordPort({ resolveRequestIdentity: async () => '12345678-1234-4234-8234-123456789abc' });
  const ctx = context(async () => proxyAnswer, port), pair = transport(), pending = deferred(), started = deferred();
  let followed = false, checks = 0;
  ctx.capture.capture(pair.request, pair.response, admission(), route(), async () => { checks++; });
  const owned = ctx.source.withWork(pair.request, async request => {
    await request.requireCurrent();
    assert.equal(Object.isFrozen(request.facts.actor), true);
    started.resolve(request.facts);
    await pending.promise;
    // A coordinator may settle an already owned operation, but cannot publish.
    assert.equal(await request.work.resolveRequestIdentity('issuer', 'subject'), request.facts.actor.id);
    await assert.rejects(request.requireCurrent(), RequestContextUnavailable);
    followed = true;
    return 'late protected body';
  });
  const facts = await started.promise;
  const second = await ctx.source.withWork(pair.request, async request => request.facts);
  assert.equal(second, facts);
  assert.equal(control.live(), 1);
  pair.response.emit('finish'); pair.response.emit('close');
  assert.throws(() => ctx.source.read(pair.request), RequestContextUnavailable);
  await assert.rejects(ctx.source.withWork(pair.request, async () => {}), RequestContextUnavailable);
  control.close();
  assert.equal(control.live(), 1);
  const refused = assert.rejects(owned, RequestContextUnavailable);
  pending.resolve();
  await refused; await control.drained();
  assert.equal(followed, true); assert.equal(checks, 1); assert.equal(control.live(), 0);
});

test('RF-5 close during identity bootstrap drains without another begin', async () => {
  const identity = deferred(), reached = deferred();
  const { port, control } = createRecordPort({ resolveRequestIdentity: async () => {
    reached.resolve(); return identity.promise;
  } });
  const ctx = context(async () => proxyAnswer, port), pair = transport();
  ctx.capture.capture(pair.request, pair.response, admission(), route(), async () => {});
  const pending = ctx.source.facts(pair.request);
  await reached.promise;
  pair.response.emit('close');
  assert.equal(control.live(), 1);
  const rejected = assert.rejects(pending, RequestContextUnavailable);
  identity.resolve('12345678-1234-4234-8234-123456789abc');
  await rejected; await control.drained();
  assert.equal(control.live(), 0);
});

test('RF-3 current check receives the existing transaction and rechecks activity after its wait', async () => {
  const { port } = createRecordPort({ resolveRequestIdentity: async () => '12345678-1234-4234-8234-123456789abc' });
  const ctx = context(async () => proxyAnswer, port), pair = transport(), checked = deferred(), release = deferred();
  const transaction = Object.freeze({ existingSourceSnapshot: true });
  ctx.capture.capture(pair.request, pair.response, admission(), route(), async tx => {
    assert.equal(tx, transaction); checked.resolve(); await release.promise;
  });
  const task = ctx.source.withWork(pair.request, async request => request.requireCurrent(transaction));
  await checked.promise;
  pair.request.emit('aborted');
  const refused = assert.rejects(task, RequestContextUnavailable);
  release.resolve(); await refused;
});

test('RF-5 earlier middleware completion observers cannot start work; end blocks before finish emits', async () => {
  let begins = 0;
  const ctx = context(async () => proxyAnswer, { begin() { begins++; throw new Error('unexpected begin'); } });
  const pair = transport();
  let observer;
  pair.response.once('finish', () => {
    assert.throws(() => ctx.source.read(pair.request), RequestContextUnavailable);
    observer = assert.rejects(ctx.source.withWork(pair.request, async () => {}), RequestContextUnavailable);
  });
  ctx.capture.capture(pair.request, pair.response, admission(), route(), async () => {});
  pair.response.emit('finish'); await observer;
  assert.equal(begins, 0);
  const ended = transport();
  ctx.capture.capture(ended.request, ended.response, admission(), route(), async () => {});
  ended.response.end();
  assert.throws(() => ctx.source.read(ended.request), RequestContextUnavailable);
  await assert.rejects(ctx.source.facts(ended.request), RequestContextUnavailable);
  assert.equal(begins, 0);
});
