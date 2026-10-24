'use strict';
// RF-1/3/4/6: real AppModule/Guard/AuthService/admin HTTP with a signed OIDC
// transport fixture and independent PG witness. Clinical Module A and real
// Keycloak/nginx compatibility remain separate acceptance cells.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../../..');
const build = process.env.KIN_B2R_BUILD || path.join(root, 'api/dist');
const apiRequire = createRequire(path.join(build, '../package.json'));
apiRequire('reflect-metadata');
const jose = apiRequire('jose');
const { PrismaClient } = apiRequire('@prisma/client');
const { NestFactory } = apiRequire('@nestjs/core');
const { EmrRuntime } = require(path.join(build, 'emr-runtime/application.js'));
const { AppModule } = require(path.join(build, 'app.module.js'));
const { AuthService } = require(path.join(build, 'auth.service.js'));
const { REQUEST_CONTEXT_SOURCE, RequestContextUnavailable } = require(path.join(build, 'emr-runtime/request-context.js'));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => server.close(resolve));

async function main() {
  const issuer = 'https://synthetic.invalid/realms/request-facts';
  const institution = 'synthetic-first-site', sub = 'synthetic-admin', target = 'synthetic-member';
  const { privateKey, publicKey } = await jose.generateKeyPair('RS256');
  const jwk = { ...await jose.exportJWK(publicKey), kid: 'request-facts', alg: 'RS256', use: 'sig' };
  let held, pendingHold;
  const provider = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/certs') return res.end(JSON.stringify({ keys: [jwk] }));
    if (req.url.endsWith('/token')) return res.end(JSON.stringify({ access_token: 'synthetic-provider-client', expires_in: 600 }));
    if (req.url.includes('/groups')) {
      if (held && req.url.startsWith('/admin/realms/kin/groups?')) {
        const wait = held; held = null; wait.reached.resolve(); await wait.release.promise;
      }
      return res.end(JSON.stringify([{ name: institution }]));
    }
    if (req.url.includes('/role-mappings')) return res.end(JSON.stringify([{ name: 'radiologist' }]));
    if (req.url.includes('/users/')) return res.end(JSON.stringify({ id: target, username: target,
      email: target + '@example.test', emailVerified: true, firstName: 'Synthetic', lastName: 'Member', enabled: true }));
    res.statusCode = 404; res.end('{}');
  });
  await listen(provider);
  Object.assign(process.env, { KC_ISSUER: issuer, KC_AUDIENCE: 'kin-api', AUTH_REQUIRED: 'true',
    KIN_COOKIE_SECRET: randomUUID(), KC_WEB_SECRET: randomUUID(), KC_CLIENT_SECRET: randomUUID(),
    PUBLIC_ORIGIN: 'https://synthetic.invalid', KC_ADMIN_URL: 'http://127.0.0.1:' + provider.address().port,
    ORTHANC_URL: 'http://127.0.0.1:' + provider.address().port, ORTHANC_USER: 'synthetic', ORTHANC_PASS: randomUUID(),
    KC_JWKS_URL: 'http://127.0.0.1:' + provider.address().port + '/certs' });
  const token = (subject = sub, iss = issuer, roles = ['admin'], extra = {}, expires = '10m') => new jose.SignJWT({
    email: 'equal-display@example.test', name: 'Equal Display', realm_access: { roles }, groups: ['/' + institution], ...extra,
  }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setIssuer(iss).setSubject(subject).setAudience('kin-api')
    .setIssuedAt().setExpirationTime(expires).sign(privateKey);
  const witness = new PrismaClient({ datasources: { db: { url: process.env.KIN_B2R_WITNESS_URL } } });
  const runtime = new EmrRuntime(process.env.DATABASE_URL, process.env.KIN_B2R_SPOOL);
  let app, proxy, blocker, unlock;
  const disconnected = deferred();
  const observations = [];
  const admissions = [];
  try {
    await witness.memberRightsImport.create({ data: { id: 'realm-v1' } });
    for (const member of [sub, target, 'synthetic-admin-two']) await witness.memberRights.create({ data: {
      sub: member, username: member, email: member + '@example.test', name: 'Equal Display', emailVerified: true,
      approved: true, suspended: false, institution, roles: member === target ? ['radiologist'] : ['admin'],
    } });
    await runtime.start();
    app = await NestFactory.create(AppModule.withLedger(runtime, { proxyPeers: ['127.0.0.1'] }), { logger: false, abortOnError: false });
    app.setGlobalPrefix('api');
    const source = app.get(REQUEST_CONTEXT_SOURCE);
    app.useGlobalInterceptors({ intercept(context, next) {
      const req = context.switchToHttp().getRequest();
      let captured = null;
      try { captured = source.read(req); } catch (error) { assert.ok(error instanceof RequestContextUnavailable); }
      admissions.push({ url: req.url, captured });
      req.user = { subject: 'request-decoration' };
      req.displayName = 'Changed decoration';
      req.headers['x-real-ip'] = '192.0.2.199';
      return next.handle();
    } });
    // Observe the real request at response completion, without replacing a Guard,
    // route, service, ledger or response body. No member context can survive it.
    app.use((req, res, next) => {
      res.once('finish', () => queueMicrotask(() => {
        let revoked = false;
        try { source.read(req); } catch (error) { revoked = error instanceof RequestContextUnavailable; }
        observations.push({ route: req.route?.path, revoked });
      }));
      res.once('close', () => queueMicrotask(() => {
        if (!res.writableFinished) {
          assert.throws(() => source.read(req), RequestContextUnavailable);
          disconnected.resolve();
        }
      }));
      next();
    });
    await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl();
    // Controlled ingress transport; the separately registered session_proxy
    // harness owns the actual deployed nginx/Keycloak acceptance cell.
    proxy = http.createServer((req, res) => {
      const upstream = http.request(origin + req.url, { method: req.method,
        headers: { ...req.headers, 'x-real-ip': req.socket.remoteAddress } }, answer => {
        res.writeHead(answer.statusCode, answer.headers); answer.pipe(res);
      });
      upstream.on('error', () => { res.statusCode = 502; res.end(); }); req.pipe(upstream);
    });
    await listen(proxy);
    const forwarded = 'http://127.0.0.1:' + proxy.address().port;
    const bearer = await token();
    const send = async (headers, body = { enabled: false }, base = forwarded) => {
      const response = await fetch(base + '/api/admin/users/' + target, { method: 'PATCH',
        headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    const events = async () => (await witness.$queryRaw`SELECT DISTINCT e.payload FROM emr_access.access_entry e
      WHERE e.payload::jsonb->>'surface' = 'PATCH admin/users/:id'`).map(row => JSON.parse(row.payload));
    const current = () => witness.memberRights.findUnique({ where: { sub: target } });
    const absent = await send({ authorization: 'Bearer ' + bearer }, { enabled: false }, origin);
    // Accepted B2 permits not-observed for rights events. Preserve that fact;
    // neither this consumer nor the test may invent a stricter admission rule.
    assert.equal(absent.status, 200); assert.equal((await current()).version, 2);
    assert.deepEqual((await events())[0].trustedProxyIp, { status: 'unresolved', reason: 'not-observed' });
    const first = await send({ authorization: 'Bearer ' + bearer, 'x-request-id': 'client-chosen',
      'x-real-ip': '192.0.2.200' });
    assert.equal(first.status, 200, JSON.stringify(first));
    let ledger = await events();
    assert.equal(ledger.length, 2);
    const observed = ledger.find(event => event.trustedProxyIp.status === 'known');
    assert.equal(observed.userId.value.issuer, issuer);
    assert.equal(observed.userId.value.subject, sub);
    assert.deepEqual(observed.trustedProxyIp.value, { address: '127.0.0.1', source: 'trusted-proxy' });
    assert.notEqual(observed.requestId, 'client-chosen');
    const identity = observed.userId.value.id;
    const changed = await token('synthetic-admin-two');
    assert.equal((await send({ authorization: 'Bearer ' + changed }, { enabled: true })).status, 200);
    ledger = await events();
    const second = ledger.find(event => event.userId.value.subject === 'synthetic-admin-two');
    assert.notEqual(second.userId.value.id, identity);
    assert.notEqual(second.requestId, ledger.find(event => event.userId.value.subject === sub).requestId);
    // Verified issuer-local collision: a changed configured issuer is verified
    // again, while the durable identity still preserves the previous issuer.
    const nextIssuer = issuer + '-next'; process.env.KC_ISSUER = nextIssuer;
    assert.equal((await send({ authorization: 'Bearer ' + await token(sub, nextIssuer) })).status, 200);
    ledger = await events();
    assert.notEqual(ledger.find(event => event.userId.value.issuer === nextIssuer).userId.value.id, identity);
    process.env.KC_ISSUER = issuer;
    const auth = app.get(AuthService);
    const sessionHeaders = async () => {
      const sid = randomUUID();
      await witness.authSession.create({ data: { sid, sub, accessToken: bearer, refreshToken: randomUUID(),
        rightsVersion: 1, institution, atExpiresAt: new Date(Date.now() + 600000), lastSeenAt: new Date() } });
      return { sid, headers: { cookie: 'kin_sid=' + sid, 'x-kin-session': auth.sessionRef(sid), 'x-kin-csrf': '1' } };
    };
    const session = await sessionHeaders();
    assert.equal((await send(session.headers, { enabled: true })).status, 200);
    const me = await fetch(origin + '/api/me', { headers: session.headers });
    assert.equal((await me.json()).sessionId, auth.sessionRef(session.sid));
    const bearerMe = await fetch(origin + '/api/me', { headers: { authorization: 'Bearer ' + bearer } });
    assert.equal((await bearerMe.json()).sessionId, null);
    assert.equal(admissions.filter(item => item.url === '/api/me').at(-1).captured.binding.sessionRef, null);
    const health = await fetch(origin + '/api/health');
    assert.equal(health.status, 200);
    assert.equal(admissions.at(-1).captured, null);
    const logout = await fetch(origin + '/api/auth/logout', { method: 'POST', headers: { authorization: 'Bearer ' + bearer } });
    assert.equal(logout.status, 204); assert.equal(admissions.at(-1).captured, null);
    const gatewayStudy = '2.25.1234567890001';
    await witness.studyState.create({ data: { uid: gatewayStudy, institutionId: institution } });
    const gatewayToken = await token('synthetic-gateway', issuer, ['gateway'], { azp: 'gw-synthetic' });
    const gateway = await fetch(origin + '/api/authz/dicom', { headers: { authorization: 'Bearer ' + gatewayToken,
      'x-original-method': 'POST', 'x-original-uri': '/dicom-web/studies/' + gatewayStudy } });
    assert.equal(gateway.status, 204); assert.equal(admissions.at(-1).captured, null);
    process.env.AUTH_REQUIRED = 'false';
    const dev = await fetch(origin + '/api/me');
    assert.equal(dev.status, 200); assert.equal(admissions.at(-1).captured, null);
    process.env.AUTH_REQUIRED = 'true';
    for (const change of ['session-replaced', 'institution', 'rights', 'isolated']) {
      const before = await current();
      const live = change === 'session-replaced' ? await sessionHeaders() : null;
      const hold = pendingHold = held = { reached: deferred(), release: deferred() };
      const pending = send(live?.headers ?? { authorization: 'Bearer ' + bearer }, {
        roles: ['radiologist'], institution, verificationOverride: true,
      });
      await hold.reached.promise;
      if (live) {
        await witness.authSession.delete({ where: { sid: live.sid } });
        await sessionHeaders();
      } else await witness.memberRights.update({ where: { sub }, data: change === 'institution'
        ? { institution: 'synthetic-other-site' } : change === 'isolated' ? { suspended: true }
          : { roles: ['radiologist'], version: { increment: 1 } } });
      hold.release.resolve();
      const refused = await pending;
      pendingHold = null;
      assert.equal(refused.status, 401, JSON.stringify({ change, refused }));
      assert.equal((await current()).version, before.version);
      await witness.memberRights.update({ where: { sub }, data: { institution, suspended: false, roles: ['admin'] } });
    }
    ledger = await events();
    assert.equal(ledger.length, 5);
    assert.ok(ledger.every(event => event.targets.length === 1 && event.targets[0].kind === 'identity-access'));
    for (const event of ledger) {
      const [affected] = await witness.$queryRaw`SELECT id::text FROM emr_access.member_identity
        WHERE issuer=${event.userId.value.issuer} AND subject=${target}`;
      assert.equal(event.targets[0].recordId.value, affected.id);
    }
    assert.deepEqual(ledger.map(event => Number(event.targets[0].versionId.value)).sort((a, b) => a - b), [2, 3, 4, 5, 6]);
    assert.equal(JSON.stringify(ledger).includes(session.sid), false);
    assert.equal(JSON.stringify(ledger).includes(bearer), false);
    const [actor] = await witness.$queryRaw`SELECT id::text FROM emr_access.member_identity WHERE issuer=${issuer} AND subject=${sub}`;
    assert.equal(actor.id, identity);
    assert.ok(observations.length > 0 && observations.every(item => item.revoked));
    const locked = deferred(), release = deferred(); unlock = release.resolve;
    blocker = witness.$transaction(async tx => {
      await tx.$executeRawUnsafe('LOCK TABLE emr_access.member_identity IN ACCESS EXCLUSIVE MODE');
      locked.resolve(); await release.promise;
    }, { timeout: 15000 }); // Existing B2 request-work SQL-wait harness bound.
    await locked.promise;
    let published = false;
    const cancelled = http.request(origin + '/api/admin/users/' + target, { method: 'PATCH',
      headers: { authorization: 'Bearer ' + bearer, 'content-type': 'application/json', 'x-real-ip': '127.0.0.1' } },
    response => { published = true; response.resume(); });
    cancelled.on('error', () => {}); cancelled.end(JSON.stringify({ enabled: false }));
    for (;;) {
      const [waiting] = await witness.$queryRaw`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE usename='kin_runtime' AND wait_event_type='Lock'`;
      if (waiting.n) break;
      await new Promise(resolve => setImmediate(resolve));
    }
    cancelled.destroy(); await disconnected.promise;
    assert.equal(published, false); assert.equal(runtime.control.live(), 1);
    release.resolve(); await blocker; blocker = null;
    await runtime.control.drained(); assert.equal(runtime.control.live(), 0);
    assert.equal((await events()).length, 5, 'Cancelled identity lookup cannot begin an admin mutation');
    // S7-U5 ④: token expiry is not a session end. The same live session's stored access token expires while this
    // admitted request waits on its source (as when a refresh-ahead is slow); the change still commits and answers.
    const still = await sessionHeaders();
    const expiring = pendingHold = held = { reached: deferred(), release: deferred() };
    const beforeExpiry = await current();
    const answered = send(still.headers, { roles: ['radiologist', 'technician'], institution, verificationOverride: true });
    await expiring.reached.promise;
    await witness.authSession.update({ where: { sid: still.sid },
      data: { accessToken: await token(sub, issuer, ['admin'], {}, Math.floor(Date.now() / 1000) - 1) } });
    expiring.release.resolve();
    const kept = await answered; pendingHold = null;
    assert.equal(kept.status, 200, JSON.stringify(kept));
    assert.equal((await current()).version, beforeExpiry.version + 1);
    assert.equal((await events()).length, 6);
    console.log(JSON.stringify({ status: 'PASS', boundary: 'AppModule real signed Guard/session/bearer/admin HTTP + independent PG',
      cases: ['unobserved ingress stays unresolved under accepted B2 contract', 'observed ingress', 'immutable issuer/subject identity', 'server request correlation',
        'sessionRef preserved; bearer null', 'source wait: session replacement/institution/rights/isolation refuse',
        'response finish revokes context', 'client disconnect during PG identity: no body, original work drains',
        'stored token expiring during an admitted request is not a session end'],
      pending: ['Module A RF-3/RF-4', 'real Keycloak/nginx RF-2/RF-6'] }));
  } finally {
    (held ?? pendingHold)?.release.resolve();
    unlock?.(); if (blocker) await blocker;
    if (proxy) await close(proxy);
    if (app) await app.close();
    await runtime.stop(Date.now() + 15000);
    await witness.$disconnect(); await close(provider);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
