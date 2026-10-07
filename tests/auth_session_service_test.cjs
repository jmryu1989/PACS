'use strict';
/* TEST-S7-U5 compiled session service (AS-01..AS-12, test-plan section 2): the access records of login, logout, account
 * switch, idle expiry, refusal of a refresh and the sweep, over the compiled controller, guard and lifecycle of the kin-api
 * image, a real disposable PostgreSQL and an in-process fake Keycloak.
 *
 * REQ-S7-U5-AUTH-AUDIT -> RISK-S7-U5-SECRET-IN-LOG / RISK-S7-U5-CROSS-INSTITUTION / RISK-S7-U5-SWEEP-SILENT
 *   -> TEST-S7-U5 (this file; TEST-S7-U5-LIVE is tests/auth_audit_live.py).
 * Contracts: the session lifecycle contract (scenario-table section 0.A, Astra S7-U5-SPEC-F01, outcome table RT-01..RT-15)
 * and the DB failure boundary contract (section 0.B, S7-U5-SPEC-F02), as replaced by Astra spec U5S (REQ-05, 08, 09, 10)
 * and its 2026-10-04 amendments: a logout revokes and records before Keycloak is told and does not wait for it; no
 * answer expires kin_sid; a cookie request names the session its document saw (X-KIN-Session); a login is entered with
 * a single-use proof; a refresh starts ahead of the token's expiry and only Keycloak's refusal of the refresh token ends
 * a session (U5S-AMD-04, U5S-TEST-S05/S07/S11, U5S-REQ-08/09 at the end of this file). The expected values are the
 * contract's literals, never read back from the implementation.
 *
 * RT rows whose fixture changed with the lead (the outcomes did not): a session whose token "has expired" is stored with
 * atExpiresAt 31 s in the past (lapsed()), and the same-exp fixtures expire within the 2 s the service already counts as
 * expired - both make the request wait for its refresh, which is what those timelines hold and release.
 *
 * Why compiled and not live: the sweep is an hourly timer with no route, and the races, the audit-write failures and the
 * late Keycloak answers cannot be timed on a live stack without test hooks (D73). So: the product's own Nest lifecycle hook
 * (onModuleInit) under node:test mock timers (setInterval and Date - jose's exp check and the fake Keycloak's exp use the
 * same mocked clock), two service instances over one database (two processes' worth of in-memory refresh sharing), a fake
 * Keycloak whose /token answers a case holds and releases, and a recording view of the real Prisma client per instance that
 * can hold a request before its next AuthSession write statement (before the transaction opens, never inside one) or make
 * one statement fail once with a synthetic error. The recorder keeps call names only - never where/data values, which carry
 * the token snapshot. Every error goes through the real Nest ExceptionsHandler (BaseExceptionFilter) and the real Nest
 * logger; the case reads what reaches the response (status, body, Set-Cookie, redirect) and what reaches stdout/stderr
 * (string writes are taken while a world runs; node:test's own protocol writes are buffers and pass through). Nothing here
 * calls a service method the controller or guard does not call, and nothing in the product exists for this file.
 *
 * KIN_AUTH_SESSION_DATABASE_URL names a disposable server's database kin_auth_session_test, which must hold no table when
 * this file starts: the image's migrations are applied with `prisma migrate deploy`, and between worlds only AuthSession and
 * AuditLog are emptied (AuditLog past its append-only guard as the disposable server's superuser, as the S7-U1a harness does).
 * Container only (kin-api image: /app/dist, /app/prisma, /app/node_modules). Synthetic identities only; the output names
 * cases, channels, kinds and counts, never a session id, token, cookie or marker value.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const jose = require('/app/node_modules/jose');
const { Reflector } = require('/app/node_modules/@nestjs/core');
const { ExceptionsHandler } = require('/app/node_modules/@nestjs/core/exceptions/exceptions-handler');
const { ExecutionContextHost } = require('/app/node_modules/@nestjs/core/helpers/execution-context-host');
const { InternalServerErrorException } = require('/app/node_modules/@nestjs/common');

const DATABASE = 'kin_auth_session_test';
const ISSUER = 'https://syn.test/auth/realms/kin';
const ORIGIN = 'https://syn.test';
const HOUR = 3600_000;
const IDLE = 12 * HOUR;
const START = Date.UTC(2026, 9, 3, 0, 0, 0);          // the mocked clock of every world
const AUTH_ACTIONS = ['auth.login', 'auth.logout', 'auth.session.expired', 'auth.entry'];
const ABSENT = '인증 세션이 없습니다', EXPIRED = '인증 세션이 만료되었습니다', REFUSED = '인증 세션을 갱신할 수 없습니다';
// The contract's lead: a stored access token is refreshed from 30 s before its expiry (atExpiresAt = exp - 30 s). A
// request before that instant is not refreshed; from it to the expiry the request goes on while a refresh runs; after
// the expiry the request waits for the refresh.
const LEAD = 30_000;
const IP = '198.51.100.7';
const A = 'syn-inst-a', B = 'syn-inst-b', Z = 'syn-inst-z';

// ── environment the compiled service reads (set before any instance is built) ──
const SECRETS = { client: 'syn-client-secret-' + randomBytes(12).toString('hex'), cookie: 'syn-cookie-secret-' + randomBytes(24).toString('hex'),
  service: 'syn-service-secret-' + randomBytes(12).toString('hex'), serviceToken: 'syn-service-token-' + randomBytes(12).toString('hex') };
Object.assign(process.env, { KC_ISSUER: ISSUER, KC_AUDIENCE: 'kin-api', PUBLIC_ORIGIN: ORIGIN, KC_WEB_SECRET: SECRETS.client,
  KIN_COOKIE_SECRET: SECRETS.cookie, KC_REALM: 'kin', KC_CLIENT_ID: 'kin-api', KC_CLIENT_SECRET: SECRETS.service });
delete process.env.AUTH_REQUIRED;

// ── the disposable database ──

let prepared = null;
function database() {
  prepared ??= (async () => {
    const url = process.env.KIN_AUTH_SESSION_DATABASE_URL;
    assert.ok(url, 'set KIN_AUTH_SESSION_DATABASE_URL to the disposable ' + DATABASE + ' database');
    assert.equal(new URL(url).pathname, '/' + DATABASE, 'refusing any database but the disposable ' + DATABASE);
    process.env.DATABASE_URL = url;
    const { PrismaService } = require('/app/dist/prisma.service');
    const base = new PrismaService();
    await base.$connect();
    const [{ tables }] = await base.$queryRawUnsafe(`SELECT count(*)::int AS tables FROM pg_tables WHERE schemaname = 'public'`);
    assert.equal(tables, 0, 'refusing a database that already holds tables: this file empties the tables it writes');
    execFileSync('/app/node_modules/.bin/prisma', ['migrate', 'deploy', '--schema', '/app/prisma/schema.prisma'],
      { cwd: '/app', env: { ...process.env, DATABASE_URL: url, HOME: os.tmpdir(), CHECKPOINT_DISABLE: '1' }, stdio: 'pipe' });
    const applied = await base.$queryRawUnsafe(`SELECT migration_name FROM _prisma_migrations
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`);
    const folders = fs.readdirSync('/app/prisma/migrations', { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
    assert.deepEqual(applied.map(row => row.migration_name).sort(), folders, 'every migration of the image applied');
    return base;
  })();
  return prepared;
}

// ── the fake Keycloak (127.0.0.1, the container's own loopback) ──

const KEYS = {};
// The provider end (S7-U5 R1): the product ends a provider session with the service account's
// DELETE /admin/realms/kin/sessions/{sid} (204 = ended now, 404 = no such session). `logouts` counts those requests as
// they arrive, `logoutMode` is how the fake answers them ('ok', 'drop' = connection cut, 'hang' = held unanswered until
// the case calls the releasers in `hung`, 'error' = 503 and 'error500' = 500 (answers that do not say whether it was done:
// S7-U5 fix round 7 - a 503 is not proof that Keycloak turned the request away before carrying it out), 'lost' = the
// session is ended and the answer is cut, 'refused' = the connection is refused (the admin API is not listening: the
// request never reaches the provider, see the fetch below)); `beforeEnd(sid)` (when a case sets it) holds a
// request before it is carried out ('drop' / '500' instead), `afterEnd(sid)` holds the answer of a request already
// carried out ('drop' cuts it) - a case releases the effect and the answer independently. `abandoned` counts requests the
// caller closed before an answer. `ended` holds the provider sessions it ended,
// `alive` (when a case sets it) the only ones it knows. `endRequests` lists the sid of every end request the product sent
// (a refused one included), `logouts` counts those that arrived. `serviceTokens` counts client_credentials grants, apart from
// `tokens` (the user-token requests a case holds and counts); `serviceMode` 'stale' answers the next DELETE 401 once,
// 'error' answers the service account's token request 503 (no change request is sent), 'hang' never answers it.
// `members` are the accounts the member administration reads (id -> {username, email, enabled, groups, roles}) and
// `userLogouts` the ids a whole-user logout (POST users/{id}/logout) named - the product sends none (S7-U5 D600; the route stays so that a case can tell). `adminCalls` lists every request to the
// member administration ('<METHOD> <what>', a refused one included); `adminDown` answers all of them 503, and `adminFail`
// answers the next n requests of one kind 503: 'sessions' (GET users/{id}/sessions), 'disable' / 'enable' (PUT users/{id}),
// 'logout' (POST users/{id}/logout) - for a change that is an answer that does not say whether it was done. `adminRefuse`
// refuses the connection of the next n changes of one kind ('disable' / 'enable'): never sent to the provider.
// No login callback or refresh reaches the member administration. `onAdmin` (when a
// case sets it) is told each member-administration request ('<METHOD> <what>') after the fake has carried it out, and the
// answer waits for what it returns: a case holds the answer of a request the provider has already done. `beforeAdmin`
// (when a case sets it) is told each such request when it arrives, BEFORE the fake carries it out: the request is carried
// out and answered only when what it returns resolves - a case holds a request the provider has not done yet, so its
// effect lands when the case lets it. Resolving to 'drop' cuts the connection without carrying the request out, '500'
// answers 500 without it; onAdmin (and afterEnd) resolving to 'drop' cuts the answer of a request carried out, '500' /
// '503' answers it 500 / 503.
// `userLogouts` stays empty unless the product asks for a whole-user logout (it must not: S7-U5 D600).
const kc = { server: null, port: 0, held: [], waiters: [], auto: null, logoutMode: 'ok', onLogout: null, logouts: 0, tokens: 0, codes: [],
  certs: 'ok', certRequests: 0, abandoned: 0, ended: [], alive: null, serviceTokens: 0, serviceMode: 'ok', endRequests: [],
  members: {}, userLogouts: [], adminDown: false, adminFail: {}, adminCalls: [], onAdmin: null, beforeAdmin: null,
  beforeEnd: null, afterEnd: null, hung: [], adminStale: {}, adminRefuse: {}, closedPort: 0 };

async function keycloak() {
  if (kc.server) return;
  // A port nobody listens on: a refused request goes there, so the real fetch fails as it does when the admin API is down.
  const closed = http.createServer();
  await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
  kc.closedPort = closed.address().port;
  await new Promise(resolve => closed.close(resolve));
  for (const name of ['main', 'other']) {
    const { publicKey, privateKey } = await jose.generateKeyPair('RS256', { extractable: true });
    KEYS[name] = { kid: 'syn-' + name, publicKey, privateKey };
  }
  const jwk = { ...(await jose.exportJWK(KEYS.main.publicKey)), kid: KEYS.main.kid, alg: 'RS256', use: 'sig' };
  kc.server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const path = req.url.split('?')[0];
      const send = (status, value) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(value === undefined ? '' : JSON.stringify(value));
      };
      if (path === '/realms/kin/protocol/openid-connect/certs') {
        kc.certRequests++;
        // 'drop' cuts the connection, 'error' answers 503: the key set cannot be fetched (the token is not at fault).
        if (kc.certs === 'drop') return req.socket.destroy();
        return kc.certs === 'error' ? send(503, { error: 'unavailable' }) : send(200, { keys: [jwk] });
      }
      const ending = /^\/admin\/realms\/kin\/sessions\/([^/]+)$/.exec(path);
      if (ending && req.method === 'DELETE') {
        const idpSid = decodeURIComponent(ending[1]);
        if (req.headers.authorization !== 'Bearer ' + SECRETS.serviceToken) return send(403, { error: 'forbidden' });
        if (kc.serviceMode === 'stale') { kc.serviceMode = 'ok'; return send(401, { error: 'HTTP 401 Unauthorized' }); }
        kc.logouts++;
        kc.endRequests.push(idpSid);
        // A request the caller gives up (closes) before it is answered is counted: the product does not give up its
        // change calls (S7-U5 D600), so a case can tell.
        res.on('close', () => { if (!res.writableEnded && !res.cutHere) kc.abandoned++; });
        const cut = () => { res.cutHere = true; req.socket.destroy(); };
        const carry = (mode, how) => {
          // 'drop' cuts the connection before anything is ended; 'error' answers 503 and 'error500' 500 without ending
          // (answers that do not say whether it was done); 'hang' holds the request unanswered
          // until the case releases it (kc.hung); 'lost' ends the session and cuts the answer. `how` is what a case's
          // beforeEnd hook said: 'drop' / '500' before the effect, or nothing (carry it out now).
          if (how === 'drop' || mode === 'drop') return cut();
          if (typeof how === 'number') return send(how);
          if (how === '500' || mode === 'error500') return send(500, { error: 'unknown_error' });
          if (mode === 'hang') return void kc.hung.push(() => carry('ok'));
          if (mode === 'error') return send(503, { error: 'unavailable' });
          const known = kc.alive ? kc.alive.includes(idpSid) : true;
          const present = known && !kc.ended.includes(idpSid);
          if (present) kc.ended.push(idpSid);
          if (mode === 'lost') return cut();
          const reply = () => present ? send(204) : send(404, { error: 'Sesssion not found' });
          // afterEnd (when a case sets it): the effect is done; the answer waits for what it returns ('drop' cuts it).
          if (kc.afterEnd)
            return void Promise.resolve(kc.afterEnd(idpSid)).then(after => typeof after === 'number' ? send(after) : after === 'drop' ? cut()
              : after === '500' ? send(500, { error: 'unknown_error' }) : after === '503' ? send(503, { error: 'unavailable' }) : reply());
          return reply();
        };
        const mode = kc.logoutMode;
        // beforeEnd (when a case sets it): the request has arrived and is carried out only when what it returns resolves.
        const answer = () => kc.beforeEnd ? void Promise.resolve(kc.beforeEnd(idpSid)).then(how => carry(mode, how)) : carry(mode);
        // What the store holds at the moment Keycloak is told: a case reads it here, before the answer.
        if (kc.onLogout) return void kc.onLogout().then(answer, answer);
        return answer();
      }
      // The member administration the admin isolation reaches (read a member, disable or enable it, list its provider sessions;
      // a whole-user logout is answered but must never be asked). `sessions` of an account are its live provider sessions
      // (GET users/{id}/sessions).
      if (path === '/admin/realms/kin/groups') return send(200, [A, B, Z].map(name => ({ id: 'syn-group-' + name, name })));
      const role = /^\/admin\/realms\/kin\/roles\/([^/]+)$/.exec(path);
      if (role) return send(200, { id: 'syn-role-' + role[1], name: role[1] });
      const member = /^\/admin\/realms\/kin\/users\/([^/]+)(\/groups(?:\/[^/]+)?|\/role-mappings\/realm|\/logout|\/sessions)?$/.exec(path);
      if (member) {
        if (req.headers.authorization !== 'Bearer ' + SECRETS.serviceToken) return send(403, { error: 'forbidden' });
        const id = decodeURIComponent(member[1]);
        const sent = (() => { try { return JSON.parse(body || '{}'); } catch { return {}; } })();
        const kind = member[2] === '/sessions' ? 'sessions' : member[2] === '/logout' ? 'logout'
          : !member[2] && req.method === 'PUT' ? (sent.enabled === false ? 'disable' : sent.enabled === true ? 'enable' : 'update')
            : !member[2] ? 'read' : member[2].slice(1);
        kc.adminCalls.push(req.method + ' ' + kind);
        // adminStale (when a case sets it) answers the next n requests of one kind 401: the service token is refused once.
        if (kc.adminStale[kind] > 0) { kc.adminStale[kind]--; return send(401, { error: 'HTTP 401 Unauthorized' }); }
        const carry = () => {
          if (kc.adminDown) return send(503, { error: 'unavailable' });
          if (kc.adminFail[kind] > 0) { kc.adminFail[kind]--; return send(503, { error: 'unavailable' }); }
          const account = kc.members[id] ?? (kc.members[id] = { username: id, email: id + '@synthetic.test', enabled: true, groups: [A], roles: ['radiologist'] });
          // onAdmin resolving to 'drop' cuts the answer of a request already carried out, '500' / '503' answers it so.
          const done = (status, value) => kc.onAdmin
            ? void Promise.resolve(kc.onAdmin(req.method + ' ' + kind, id)).then(how => typeof how === 'number' ? send(how) : how === 'drop' ? req.socket.destroy()
              : how === '500' ? send(500, { error: 'unknown_error' }) : how === '503' ? send(503, { error: 'unavailable' })
                : send(status, value)) : send(status, value);
          if (!member[2] && req.method === 'GET')
            return done(200, { id, username: account.username, email: account.email, enabled: account.enabled, emailVerified: true });
          if (!member[2] && req.method === 'PUT') { Object.assign(account, sent); return done(204); }
          if (member[2] === '/groups' && req.method === 'GET') return done(200, account.groups.map(name => ({ id: 'syn-group-' + name, name, path: '/' + name })));
          if (member[2] === '/role-mappings/realm' && req.method === 'GET') return done(200, account.roles.map(name => ({ name })));
          if (member[2]?.startsWith('/groups/') && ['PUT', 'DELETE'].includes(req.method)) {
            const name = decodeURIComponent(member[2].slice('/groups/syn-group-'.length));
            account.groups = account.groups.filter(g => g !== name);
            if (req.method === 'PUT') account.groups.push(name);
            return done(204);
          }
          if (member[2] === '/role-mappings/realm' && ['POST', 'DELETE'].includes(req.method)) {
            const names = sent.map(r => r.name);
            account.roles = account.roles.filter(r => !names.includes(r));
            if (req.method === 'POST') account.roles.push(...names);
            return done(204);
          }
          if (member[2] === '/sessions' && req.method === 'GET')
            return done(200, (account.sessions ?? []).filter(sid => !kc.ended.includes(sid)).map(sid => ({ id: sid, userId: id })));
          if (member[2] === '/logout' && req.method === 'POST') {
            kc.userLogouts.push(id);
            for (const sid of account.sessions ?? []) if (!kc.ended.includes(sid)) kc.ended.push(sid);
            return done(204);
          }
          return send(404, { error: 'not_found' });
        };
        if (kc.beforeAdmin)
          return void Promise.resolve(kc.beforeAdmin(req.method + ' ' + kind, id)).then(how => typeof how === 'number' ? send(how) : how === 'drop' ? req.socket.destroy()
            : how === '500' ? send(500, { error: 'unknown_error' }) : carry());
        return carry();
      }
      if (path === '/realms/kin/protocol/openid-connect/token') {
        const form = Object.fromEntries(new URLSearchParams(body));
        // The service account's own token (the admin call above): answered at once, apart from the user tokens.
        if (form.grant_type === 'client_credentials') {
          kc.serviceTokens++;
          if (kc.serviceMode === 'hang') return undefined;
          if (kc.serviceMode === 'error') return send(503, { error: 'unavailable' });
          return form.client_id === 'kin-api' && form.client_secret === SECRETS.service
            ? send(200, { access_token: SECRETS.serviceToken, expires_in: 300, token_type: 'Bearer' })
            : send(401, { error: 'unauthorized_client' });
        }
        kc.tokens++;
        if (form.grant_type === 'authorization_code') kc.codes.push({ code: form.code, verifier: form.code_verifier });
        const request = {
          form,
          answer(reply) {
            if (reply === 'drop') return req.socket.destroy();
            if (reply === 'hang') return undefined;          // never answered: the caller's own bound ends the wait
            if (reply === 'unreadable') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>SYN gateway page</html>'); }
            send(reply[0], reply[1]);
          },
        };
        if (kc.auto) return request.answer(kc.auto(form));
        kc.held.push(request);
        for (const waiter of kc.waiters.splice(0)) waiter();
        return undefined;
      }
      return send(404, { error: 'not_found' });
    });
  });
  await new Promise(resolve => kc.server.listen(0, '127.0.0.1', resolve));
  kc.port = kc.server.address().port;
  process.env.KC_JWKS_URL = `http://127.0.0.1:${kc.port}/realms/kin/protocol/openid-connect/certs`;
  process.env.KC_ADMIN_URL = `http://127.0.0.1:${kc.port}`;
}

// Provider end requests the process has started (an end tells Keycloak after its answer is decided and does not wait
// for it): the cases wait until what was started has arrived - and been answered or given up - before they count.
const idp = { started: 0, open: 0 };
const realFetch = globalThis.fetch;
// A refused change (kc.logoutMode 'refused' for an end, kc.adminRefuse for a member change) goes to the closed port: the
// real fetch fails to connect and the provider never sees it; it is listed where the fake lists what arrives.
const changeKind = body => { try { const sent = JSON.parse(body); return sent.enabled === false ? 'disable' : sent.enabled === true ? 'enable' : null; } catch { return null; } };
globalThis.fetch = (input, init) => {
  const url = String(input);
  const end = /\/admin\/realms\/kin\/sessions\/([^/]+)$/.exec(url);
  const change = !end && init?.method === 'PUT' && /\/admin\/realms\/kin\/users\/[^/?]+$/.test(url) ? changeKind(init.body) : null;
  // Configure the HTTP transport's header wait in U3; distinct from the application's response budget.
  if ((end || change) && kc.transportTimeoutMs) init = { ...init, signal: AbortSignal.timeout(kc.transportTimeoutMs) };
  if (end ? kc.logoutMode === 'refused' : kc.adminRefuse[change] > 0) {
    if (end) kc.endRequests.push(decodeURIComponent(end[1]));
    else { kc.adminRefuse[change]--; kc.adminCalls.push('PUT ' + change); }
    input = url.replace(`//127.0.0.1:${kc.port}/`, `//127.0.0.1:${kc.closedPort}/`);
  }
  if (!end) return realFetch(input, init);
  idp.started++;
  idp.open++;
  const settle = () => { idp.open--; };
  const sent = realFetch(input, init);
  sent.then(settle, settle);
  return sent;
};

/** The n-th /token request held since the world began (1-based), in arrival order. */
async function heldToken(n, label = 'a /token request') {
  // Real time: the mocked clock does not move by itself.
  const until = performance.now() + 10_000;
  while (kc.held.length < n) {
    if (performance.now() > until) throw new Error(`harness: ${label} (#${n}) never reached the fake Keycloak`);
    await new Promise(resolve => { kc.waiters.push(resolve); setTimeout(resolve, 50); });
  }
  return kc.held[n - 1];
}

const reply = {
  tokens: v => [200, { access_token: v.access, refresh_token: v.refresh, token_type: 'Bearer', expires_in: 60 }],
  reject: () => [400, { error: 'invalid_grant', error_description: 'SYN refused' }],
  drop: () => 'drop',
  // Not a refusal: Keycloak could not be reached, answered late, failed, or answered something that is not its answer.
  hang: () => 'hang',
  unreadable: () => 'unreadable',
  failing: () => [503, { error: 'temporarily_unavailable' }],
  misconfigured: () => [401, { error: 'invalid_client' }],
};

test.after(async () => {
  if (prepared) await (await prepared).$disconnect();
  if (kc.server) {
    // A failed behavioural assertion can leave a deliberately held HTTP response. Teardown must still report the failure.
    kc.server.closeAllConnections();
    await new Promise(resolve => kc.server.close(resolve));
  }
});

// Round 10: D600/D604 -> revoked authority, supersession, unknown effects and bounded activation risks
// -> R10-01..R10-11 and U1..U9 below. Assertions concern accepted requests, surviving sessions/provider effects,
// durable facts and audit outcomes. Store hooks only schedule statements; no product source is inspected.
const R10_CALLER = { roles: ['admin'], actor: 'syn-r10-admin@synthetic.test', sub: 'syn-r10-admin' };
function r10Admin(w, inst = w.I1) {
  const { AdminService } = require('/app/dist/admin.service');
  return new AdminService(inst.prisma, new KeycloakService(), null, inst.service);
}
function r10Member(sub, sessions = [], groups = [A], roles = ['radiologist']) {
  kc.members[sub] = { username: sub, email: sub + '@synthetic.test', enabled: true, groups, roles, sessions };
  return sub;
}
const r10Answer = p => p.then(user => ({ status: 200, user }), error => ({ status: error.getStatus?.() ?? 500, body: error.getResponse?.() ?? {} }));
const r10Patch = (admin, sub, body) => r10Answer(admin.patchUser(sub, body, R10_CALLER));
const r10Fact = (w, sub) => w.base.memberIsolation.findUnique({ where: { sub } });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function r10Survives(w, sub, idpSid, entered, label) {
  assert.ok(await w.base.authSession.findUnique({ where: { sid: entered.newSid } }), label + ': product row survives');
  assert.equal(kc.ended.includes(idpSid), false, label + ': provider SSO survives');
  await w.base.authSession.update({ where: { sid: entered.newSid }, data: { atExpiresAt: lapsed() } });
  const renewed = await w.issue(label + '-refresh', { sub, idp: idpSid });
  kc.auto = () => kc.ended.includes(idpSid) ? reply.reject() : reply.tokens(renewed);
  assert.equal((await w.call(w.I2, 'get', { sid: entered.newSid })).status, 200, label + ': refresh survives');
  kc.auto = null;
}
async function r10Refuses(w, sub, token, sid, label) {
  const calls = kc.adminCalls.length, ends = kc.endRequests.length, tokens = kc.tokens;
  assert.equal((await w.call(w.I2, 'get', { sid })).status, 401, label + ': cookie');
  assert.equal((await w.call(w.I2, 'get', { bearer: token.access })).status, 401, label + ': Bearer');
  await assert.rejects(w.I2.service.authenticateSession(sid, {}), e => e.getStatus?.() === 401, label + ': direct authentication');
  await w.base.authSession.update({ where: { sid }, data: { atExpiresAt: lapsed() } });
  assert.equal((await w.call(w.I2, 'get', { sid })).status, 401, label + ': expired refresh');
  assert.equal(kc.tokens, tokens, label + ': no provider exchange for the blocked refresh');
  const callback = await login(w, w.I2, token);
  assert.equal(callback.done.newSid, null, label + ': callback');
  assert.equal(kc.adminCalls.length, calls, label + ': no administration on any authentication path');
  assert.equal(kc.endRequests.length, ends, label + ': no DELETE on callback');
}

test('R10-01 initial Suspend keeps its first generation across product-row discovery, same/different sid', async t => {
  const w = await world(t), first = r10Admin(w), other = r10Admin(w, w.I2);
  for (const reuse of [true, false]) {
    const m = r10Member('syn-r1001-' + reuse), P = 'syn-r1001-idp-' + reuse;
    kc.members[m].sessions = [P];
    const old = await w.session(await w.issue(m + '-old', { sub: m, idp: P }));
    const held = w.pause({ inst: 'I1', model: '$transaction', phase: 'after' }, e => e.result?.sub === m);
    const suspended = r10Patch(first, m, { enabled: false });
    await held.arrived();
    assert.ok(await r10Fact(w, m), 'fact committed before product discovery');
    assert.equal((await r10Patch(other, m, { enabled: true })).status, 200);
    const Q = reuse ? P : P + '-new';
    w.tick(1000); kc.ended = kc.ended.filter(s => s !== Q); kc.members[m].sessions = [Q];
    const fresh = (await login(w, w.I2, await w.issue(m + '-new', { sub: m, idp: Q, authTime: Date.now() / 1000 }))).done;
    assert.ok(fresh.newSid);
    const asks = kc.endRequests.length;
    held.release();
    const answer = await suspended;
    assert.deepEqual([answer.status, answer.body?.code], [409, 'USER_ISOLATED']);
    await quiet(w);
    assert.equal(kc.endRequests.length, asks, 'old initial command sends no late DELETE');
    assert.equal(await w.version(old), null);
    await r10Survives(w, m, Q, fresh, m);
  }
  await w.finish('R10-01');
});

test('R10-02 Activate cannot claim a Suspend created after its first read', async t => {
  const w = await world(t), admin = r10Admin(w), other = r10Admin(w, w.I2), m = r10Member('syn-r1002');
  assert.equal((await r10Patch(admin, m, { enabled: false })).status, 200);
  const held = w.pause({ inst: 'I1', model: '$transaction', phase: 'after' }, e => e.result?.sub === m);
  const run = r10Patch(admin, m, { enabled: true }); await held.arrived();
  assert.equal((await r10Patch(other, m, { enabled: false })).status, 200);
  const current = await r10Fact(w, m), calls = kc.adminCalls.length;
  held.release(); const answer = await run;
  assert.deepEqual([answer.status, answer.body?.code, await r10Fact(w, m)], [409, 'USER_ISOLATED', current]);
  assert.equal(kc.adminCalls.slice(calls).includes('PUT enable'), false);
  await w.finish('R10-02');
});

test('R10-03 approve/cancel carry their own isolation through reactivation; a newer Suspend wins', async t => {
  const w = await world(t), admin = r10Admin(w), other = r10Admin(w, w.I2);
  for (const cancel of [false, true]) {
    const m = r10Member('syn-r1003-' + cancel);
    let changed = false;
    w.observe({ inst: 'I1', model: 'memberCredential', method: 'upsert', phase: 'after' }, e => { if (e.args.where.sub === m) changed = true; });
    const held = w.pause({ inst: 'I1', model: '$transaction', phase: 'after' }, () => changed);
    const run = r10Patch(admin, m, cancel ? { approvalState: 'PENDING' } : { institution: B, roles: ['clinician'] });
    await held.arrived();
    assert.equal((await r10Patch(other, m, { enabled: false })).status, 200);
    const current = await r10Fact(w, m), n = kc.adminCalls.length;
    held.release(); const out = await run;
    assert.deepEqual([out.status, out.body?.code, await r10Fact(w, m)], [409, 'USER_ISOLATED', current]);
    assert.equal(kc.adminCalls.slice(n).includes('PUT enable'), false);
    assert.equal(await w.base.auditLog.count({ where: { target: m, action: 'admin.user.patch.failed' } }), 1);
  }
  await w.finish('R10-03');
});

test('R10-04 no-fact Activate blocks locally before enable, including effect followed by 503/reset/no response', async t => {
  const w = await world(t), admin = r10Admin(w);
  for (const outcome of ['503', 'drop', 'held']) {
    const m = r10Member('syn-r1004-' + outcome), token = await w.issue(m, { sub: m }), sid = await w.session(token);
    kc.members[m].enabled = false;
    const held = holdAdmin('PUT enable', 'after', m), run = activation(admin, m, R10_CALLER);
    await held.arrived();
    assert.equal(kc.members[m].enabled, true, 'external effect already applied');
    assert.ok(await r10Fact(w, m), 'local fact precedes enable');
    if (outcome !== 'held') held.release(outcome);
    const out = await run.result;
    assert.deepEqual([out.status, out.body?.code, run.took < 15000], [409, 'ACTIVATION_UNCONFIRMED', true]);
    await r10Refuses(w, m, token, sid, outcome);
    const restarted = w.instance('R04-' + outcome);
    await assert.rejects(restarted.service.authenticateSession(sid, {}), e => e.getStatus?.() === 401);
    assert.equal(await w.base.providerChange.count({ where: { sub: m, kind: 'enable', state: 'unknown' } }), 1);
    held.release(outcome === 'held' ? 'drop' : undefined);
    await quiet(w);
  }
  await w.finish('R10-04');
});

test('R10-05 a committed DB fact alone refuses cookie/Bearer/authenticateSession/refresh/covered callback on another instance', async t => {
  const w = await world(t), admin = r10Admin(w), m = r10Member('syn-r1005');
  const token = await w.issue(m, { sub: m }), sid = await w.session(token);
  w.fault('I1', 'tx.delete', new Error('synthetic row deletion failure'));
  assert.equal((await r10Patch(admin, m, { enabled: false })).status, 409);
  assert.ok(await w.base.authSession.findUnique({ where: { sid } }), 'product row survived the failed deletion');
  await w.base.idpSessionEnd.create({ data: { idpSid: token.idp, cause: 'isolation', decidedAt: new Date(), confirmedAt: new Date(), nextAttemptAt: new Date() } });
  const start = performance.now();
  await r10Refuses(w, m, token, sid, 'committed fact');
  assert.ok(performance.now() - start < 2000, 'covering mark adds no five-second provider wait');
  assert.equal((await w.call(w.I2, 'logout', { sid })).status, 204, 'ending remains allowed');
  await w.finish('R10-05');
});

test('R10-06 old plain/probe callbacks refuse without reopening an ended authentication or deleting its successor', async t => {
  const w = await world(t, { now: START + 400 });
  for (const probe of [false, true]) for (const same of [false, true]) {
    const m = 'syn-r1006-' + probe + same, n = same ? m : m + '-next', P = m + '-idp';
    const old = await w.issue(m + '-old', { sub: m, idp: P, authTime: Math.floor(Date.now() / 1000) });
    const sid = await w.session(old);
    const begin = await w.call(w.I1, probe ? 'switch' : 'login', probe ? { body: SWITCH } : {});
    const hold = w.gate('I1', 'tx.open'), run = answerFlow(w, w.I1, begin, old); await hold.arrived();
    assert.equal((await w.call(w.I2, 'logout', { sid })).status, 204); await w.told();
    const mark = await w.mark(P); w.tick(1000); kc.ended = kc.ended.filter(s => s !== P);
    const entered = (await login(w, w.I2, await w.issue(n + '-new', { sub: n, idp: P, authTime: Math.floor(Date.now() / 1000) }))).done;
    assert.ok(entered.newSid); const sent = kc.endRequests.length;
    hold.release(); const out = await run; await quiet(w);
    assert.equal(out.newSid, null, 'old authentication only refuses');
    assert.equal(kc.endRequests.length, sent, 'no new DELETE');
    assert.deepEqual(await w.mark(P), mark, 'confirmed mark is not reopened');
    await r10Survives(w, n, P, entered, n);
  }
  await w.finish('R10-06');
});

test('R10-07 late first/second/retry session lists are discarded when the same sid has a later admitted authentication', async t => {
  const w = await world(t, { now: START + 400 }), admin = r10Admin(w);
  for (const stage of ['first', 'second', 'retry']) {
    const m = r10Member('syn-r1007-' + stage), n = m + '-next', P = m + '-idp';
    const old = await w.session(await w.issue(m, { sub: m, idp: P, authTime: Math.floor(Date.now() / 1000) - 60 }));
    const end = holdEnd(P, 'before');
    await w.call(w.I2, 'logout', { sid: old }); await end.arrived();
    // The listing snapshots M's P while its first DELETE is still pending.
    kc.members[m].sessions = [P]; let listing, run, cycle;
    if (stage === 'retry') {
      kc.adminFail = { sessions: 2 };
      await r10Patch(admin, m, { enabled: false }); kc.adminFail = {};
      listing = holdAdmin('GET sessions', 'after', m);
      cycle = w.instance('R07'); cycle.service.onModuleInit();
    } else if (stage === 'second') {
      // First list is empty; add P only once disable is answered.
      kc.members[m].sessions = [];
      const disabled = holdAdmin('PUT disable', 'after', m);
      run = r10Patch(admin, m, { enabled: false }); await disabled.arrived();
      kc.members[m].sessions = [P]; listing = holdAdmin('GET sessions', 'after', m); disabled.release();
    } else {
      listing = holdAdmin('GET sessions', 'after', m); run = r10Patch(admin, m, { enabled: false });
    }
    await listing.arrived(); end.release(); await w.told();
    await w.until('original end confirmed', async () => !!(await w.mark(P))?.confirmedAt);
    w.tick(1000); kc.ended = kc.ended.filter(s => s !== P); kc.members[m].sessions = [];
    const next = (await login(w, w.I2, await w.issue(n, { sub: n, idp: P, authTime: Math.floor(Date.now() / 1000) }))).done;
    assert.ok(next.newSid); const asks = kc.endRequests.length, lists = kc.adminCalls.filter(c => c === 'GET sessions').length;
    listing.release(); if (run) assert.equal((await run).status, 200);
    if (cycle) { await w.until('retry finished', async () => !!(await r10Fact(w, m))?.providerDoneAt); cycle.service.onModuleDestroy(); }
    await quiet(w);
    assert.equal(kc.endRequests.length, asks, stage + ': stale list never sends a new DELETE');
    assert.ok(kc.adminCalls.filter(c => c === 'GET sessions').length > lists, stage + ': member is re-listed');
    await r10Survives(w, n, P, next, n);
  }
  await w.finish('R10-07');
});

test('R10-08 one absolute activation deadline covers actual DB contention and success audit; never clears after the answer', async t => {
  const w = await world(t), admin = r10Admin(w);
  for (const table of ['MemberIsolation', 'AuditLog']) {
    const m = r10Member('syn-r1008-' + table);
    assert.equal((await r10Patch(admin, m, { enabled: false })).status, 200);
    const enabled = holdAdmin('PUT enable', 'after', m), run = activation(admin, m, R10_CALLER);
    await enabled.arrived();
    await delay(12500);
    const locked = deferred(), release = deferred();
    const lock = w.base.$transaction(async tx => {
      await tx.$executeRawUnsafe('LOCK TABLE "' + table + '" IN ACCESS EXCLUSIVE MODE');
      locked.resolve(); await release.promise;
    }, { maxWait: 1000, timeout: 10000 });
    await locked.promise; enabled.release();
    try {
      const out = await run.result;
      assert.deepEqual([out.status, out.body?.code], [409, 'ACTIVATION_UNCONFIRMED']);
      assert.ok(run.took <= 15000, table + ': complete response <= 15 seconds');
    } finally { release.resolve(); await lock; }
    await delay(300);
    assert.ok(await r10Fact(w, m), table + ': no deferred clear');
    assert.equal(await w.base.auditLog.count({ where: { target: m, action: 'admin.user.activate' } }), 0, 'no success audit after rollback');
  }
  await w.finish('R10-08');
});

test('R10-09 same-second Bearer exception belongs only to the token actually admitted', async t => {
  const w = await world(t, { now: START + 400 }), m = 'syn-r1009', P = m + '-idp', authTime = Math.floor(Date.now() / 1000);
  const old = await w.issue(m + '-old', { sub: m, idp: P, authTime }), sid = await w.session(old);
  const start = await w.call(w.I1, 'switch', { sid, body: UNFINISHED });
  const next = await w.issue(m + '-new', { sub: m, idp: P, authTime });
  const entered = await answerFlow(w, w.I2, start, next);
  assert.ok(entered.newSid, 'new authentication admitted in the very same second');
  assert.equal((await w.call(w.I2, 'get', { bearer: next.access })).status, 200);
  assert.equal((await w.call(w.I1, 'get', { bearer: old.access })).status, 401, 'same sub/sid/auth_time cannot resurrect old JWT');
  await w.finish('R10-09');
});

test('R10-10 approval credential effects remain blocking until complete; old-institution tokens and callbacks stay revoked', async t => {
  const w = await world(t), admin = r10Admin(w), other = r10Admin(w, w.I2);
  for (const stage of ['group', 'role-remove', 'role-add'])
  for (const [phase, lost] of [['before', false], ['before', true], ['after', false], ['after', true], ['planning', false]]) {
    const m = r10Member('syn-r1010-' + stage + phase + lost);
    const token = await w.issue(m + '-old', { sub: m, groups: [A], idp: m + '-unlisted' });
    const begin = await w.call(w.I2, 'login');
    let held, run;
    if (phase === 'planning') {
      const disabled = holdAdmin('PUT disable', 'after', m);
      run = r10Patch(admin, m, { institution: B, roles: ['clinician'] }); await disabled.arrived();
      held = holdAdmin(stage === 'group' ? 'GET groups' : 'GET role-mappings/realm', 'before', m); disabled.release();
    } else {
      held = holdAdmin(stage === 'group' ? 'PUT groups/syn-group-' + B
        : (stage === 'role-remove' ? 'DELETE' : 'POST') + ' role-mappings/realm', phase, m);
      run = r10Patch(admin, m, { institution: B, roles: ['clinician'] });
    }
    await held.arrived();
    const act = await r10Patch(other, m, { enabled: true });
    assert.ok([400, 409].includes(act.status), 'pending credentials must refuse Activate, including an intermediate INVALID role set');
    if (act.status === 409) assert.equal(act.body?.code, 'ACTIVATION_UNCONFIRMED');
    assert.ok(await r10Fact(w, m));
    const middle = await w.issue(m + '-middle', { sub: m, groups: [...kc.members[m].groups], roles: [...kc.members[m].roles] });
    assert.equal((await login(w, w.I2, middle)).done.newSid, null, 'no intermediate-credential session');
    assert.equal(kc.adminCalls.includes('PUT enable'), false, 'no enable while credential stage pending');
    held.release(lost ? 'drop' : undefined);
    const answer = await run;
    if (lost) {
      assert.deepEqual([answer.status, answer.body?.code], [409, 'USER_ISOLATED']);
      assert.ok(await r10Fact(w, m));
      assert.equal(await w.base.providerChange.count({ where: { sub: m, kind: 'credentials', state: 'unknown' } }), 1);
    } else {
      assert.equal(answer.status, 200);
      assert.equal(await r10Fact(w, m), null);
      assert.equal((await w.call(w.I2, 'get', { bearer: token.access })).status, 401, 'old A rights revoked after A -> B');
      assert.equal((await answerFlow(w, w.I2, begin, token)).newSid, null, 'old callback carrying A rights revoked');
      const current = await w.issue(m + '-current', { sub: m, groups: [B], roles: ['clinician'] });
      const entered = (await login(w, w.I2, current)).done;
      assert.ok(entered.newSid, 'B credentials admitted without an administration check');
      assert.equal((await w.call(w.I2, 'me', { sid: entered.newSid })).status, 200);
    }
    kc.adminCalls = [];
  }
  await w.finish('R10-10');
});

test('R10-11 end-record commits and completion/clear share the member gate on real PostgreSQL', async t => {
  const w = await world(t), admin = r10Admin(w);
  for (const finisher of [false, true]) {
    const m = r10Member('syn-r1011-' + finisher), P = m + '-idp';
    assert.equal((await r10Patch(admin, m, { enabled: false })).status, 200);
    // A surviving row represents an already-started logout concurrent with administrative completion.
    const sid = await w.session(await w.issue(m, { sub: m, idp: P }));
    const pending = w.pause({ inst: 'I2', model: 'providerChange', method: 'create', phase: 'before' }, e => e.args.data.sub === m);
    kc.logoutMode = 'drop';
    const end = w.call(w.I2, 'logout', { sid }); await pending.arrived();
    let completed = false;
    const run = r10Patch(admin, m, { enabled: !finisher }).finally(() => { completed = true; });
    if (process.env.KIN_R10_REAL_PG === '1') {
      // Wait for a real database wait or the competing HTTP answer, not an assumed scheduling delay.
      await w.until('completion waits for the end transaction', async () => completed ||
        (await w.base.$queryRawUnsafe("SELECT EXISTS (SELECT 1 FROM pg_locks WHERE NOT granted AND locktype = 'advisory') AS waiting"))[0].waiting);
    } else await delay(100);
    assert.equal(completed, false, 'a completion cannot cross an uncommitted known-member end record');
    pending.release(); assert.equal((await end).status, 204);
    const out = await run;
    assert.equal(out.status, 409, 'unknown committed first: neither completion nor clear succeeds');
    const fact = await r10Fact(w, m); assert.ok(fact);
    if (finisher) assert.equal(fact.providerDoneAt, null, 'finisher cannot record completion over unknown');
    assert.equal(await w.base.providerChange.count({ where: { sub: m, state: 'unknown' } }) > 0, true);
  }
  for (const finisher of [false, true]) {
    const m = r10Member('syn-r1011-last-gap-' + finisher), P = m + '-idp';
    assert.equal((await r10Patch(admin, m, { enabled: false })).status, 200);
    // A durable end answer whose confirmation was interrupted; the sid retry still owes a request.
    await w.base.idpSessionEnd.create({ data: { idpSid: P, cause: 'logout', decidedAt: new Date(), nextAttemptAt: new Date() } });
    await w.base.providerChange.create({ data: { sub: m, kind: 'end_session', target: P, generation: 0, state: 'done', createdAt: new Date(), settledAt: new Date() } });
    const gap = w.pause({ inst: 'I1', model: 'memberIsolation', method: finisher ? 'update' : 'delete', phase: 'before' },
      e => e.args.where.sub === m && (!finisher || e.args.data.providerDoneAt instanceof Date));
    const run = r10Patch(admin, m, { enabled: !finisher }); await gap.arrived();
    kc.logoutMode = 'drop';
    const retry = w.instance('R11-gap-' + finisher); retry.service.onModuleInit();
    if (process.env.KIN_R10_REAL_PG === '1') {
      await w.until('retry waits in the final unknown-read/write gap', async () =>
        await w.base.providerChange.count({ where: { sub: m, state: 'unknown' } }) > 0 ||
        (await w.base.$queryRawUnsafe("SELECT EXISTS (SELECT 1 FROM pg_locks WHERE NOT granted AND locktype = 'advisory') AS waiting"))[0].waiting);
    } else await delay(100);
    assert.equal(await w.base.providerChange.count({ where: { sub: m, state: 'unknown' } }), 0,
      'new end intent cannot commit between the final unknown read and completion/clear');
    gap.release();
    assert.equal((await run).status, 200, 'completion ordered first may finish');
    await w.until('the ordered-later end is durably recorded', async () =>
      await w.base.providerChange.count({ where: { sub: m, state: 'unknown' } }) > 0);
    retry.service.onModuleDestroy();
  }
  await w.finish('R10-11');
});

test('U1 HTTP-OUTCOMES: PUT/DELETE non-204 2xx, 404, final 401, other 4xx, 501 and uncertain 5xx', async t => {
  const w = await world(t), admin = r10Admin(w);
  for (const kind of ['enable', 'end_session']) for (const status of [200, 202, 204, 404, 401, 403, 409, 501, 502, 504]) {
    const m = r10Member('syn-u1-' + kind + status), P = m + '-idp';
    if (kind === 'enable') {
      kc.onAdmin = name => name === 'PUT enable' ? status : undefined;
      const out = await r10Patch(admin, m, { enabled: true });
      assert.equal(out.status, status < 300 ? 200 : 409, kind + ' ' + status);
    } else {
      kc.afterEnd = () => status;
      const sid = await w.session(await w.issue(m, { sub: m, idp: P }));
      assert.equal((await w.call(w.I1, 'logout', { sid })).status, 204); await w.told();
    }
    const state = status < 300 || (status === 404 && kind === 'end_session') ? 'done' : status < 500 || status === 501 ? 'void' : 'unknown';
    await w.until('HTTP outcome persisted', async () => (await w.base.providerChange.findFirst({ where: { sub: m, kind }, orderBy: { id: 'desc' } }))?.outcome != null);
    const changes = await w.base.providerChange.findMany({ where: { sub: m, kind } });
    assert.ok(changes.length > 0); assert.ok(changes.every(c => c.state === state), kind + ' ' + status + ': own response classification');
    if (kind === 'end_session') assert.equal(!!(await w.mark(P))?.confirmedAt, state === 'done');
    else assert.equal(!!await r10Fact(w, m), state !== 'done', 'failure never clears the fact');
    kc.onAdmin = null; kc.afterEnd = null;
  }
  await w.finish('U1');
});

test('U2 401-THEN-CHANGE-503: the second mutation, not service-token acquisition, answers 503', async t => {
  const w = await world(t), admin = r10Admin(w);
  for (const kind of ['enable', 'end_session']) {
    const m = r10Member('syn-u2-' + kind), P = m + '-idp';
    if (kind === 'enable') {
      kc.adminStale = { enable: 1 }; kc.onAdmin = name => name === 'PUT enable' ? '503' : undefined;
      assert.equal((await r10Patch(admin, m, { enabled: true })).status, 409);
      assert.equal(kc.adminCalls.filter(c => c === 'PUT enable').length, 2, 'second PUT actually sent');
    } else {
      kc.serviceMode = 'stale'; kc.afterEnd = () => '503';
      const sid = await w.session(await w.issue(m, { sub: m, idp: P }));
      await w.call(w.I2, 'logout', { sid }); await w.told();
      assert.equal((await w.mark(P)).confirmedAt, null);
    }
    await w.until('second change 503 persisted', async () => (await w.base.providerChange.findFirst({ where: { sub: m, kind } }))?.outcome === 'http_503');
    assert.equal(await w.base.providerChange.count({ where: { sub: m, kind, state: 'unknown' } }), 1);
    kc.onAdmin = null; kc.afterEnd = null;
  }
  await w.finish('U2');
});

test('U3 HEADERS-TIMEOUT: provider effect with no headers reaches transport timeout and stays unknown', async t => {
  const w = await world(t), admin = r10Admin(w);
  for (const kind of ['enable', 'end_session']) {
    const m = r10Member('syn-u3-' + kind), P = m + '-idp';
    const held = kind === 'enable' ? holdAdmin('PUT enable', 'after', m) : holdEnd(P, 'after');
    kc.transportTimeoutMs = 250;
    let run;
    if (kind === 'enable') run = r10Patch(admin, m, { enabled: true });
    else run = w.call(w.I1, 'logout', { sid: await w.session(await w.issue(m, { sub: m, idp: P })) });
    await held.arrived();
    assert.equal(kind === 'enable' ? kc.members[m].enabled : kc.ended.includes(P), true, 'effect precedes missing headers');
    await run;
    await w.until('transport failure persisted', async () => (await w.base.providerChange.findFirst({ where: { sub: m, kind } }))?.outcome != null);
    assert.equal((await w.base.providerChange.findFirst({ where: { sub: m, kind } }))?.outcome, 'transport');
    held.release(); kc.transportTimeoutMs = 0; await quiet(w);
    assert.equal(await w.base.providerChange.count({ where: { sub: m, kind, state: 'unknown' } }), 1, 'late inaccessible response cannot settle the call');
    if (kind === 'enable') assert.ok(await r10Fact(w, m));
    else assert.equal((await w.mark(P)).confirmedAt, null);
  }
  await w.finish('U3');
});

test('U4 CRASH-CUTS: all change kinds preserve recorded uncertainty across store/send/settle cuts and second-instance recovery', async t => {
  const w = await world(t), admin = r10Admin(w);
  for (const kind of ['disable', 'enable', 'end_session']) {
    for (const cut of ['before-record', 'after-record-before-commit', 'after-commit-before-send', 'before-effect', 'after-effect', 'settle-fails-three', 'after-settle']) {
      const m = r10Member('syn-u4-' + kind + '-' + cut), P = m + '-idp';
      let armed = true, committedChange = false, failures = 0;
      w.observe({ inst: 'I1', model: 'providerChange', method: 'create', phase: cut === 'after-record-before-commit' ? 'after' : 'before' }, e => {
        if (!armed || e.args.data.sub !== m || e.args.data.kind !== kind) return;
        if (cut === 'before-record' || cut === 'after-record-before-commit') { armed = false; throw new Error('synthetic process cut'); }
      });
      w.observe({ inst: 'I1', model: 'providerChange', method: 'create', phase: 'after' }, e => {
        if (e.args.data.sub === m && e.args.data.kind === kind) committedChange = true;
      });
      w.observe({ inst: 'I1', model: '$transaction', phase: 'after' }, () => {
        if (armed && committedChange && cut === 'after-commit-before-send') { armed = false; throw new Error('synthetic process lost after commit'); }
      });
      w.observe({ inst: 'I1', model: 'providerChange', method: 'updateMany', phase: cut === 'after-settle' ? 'after' : 'before' }, async e => {
        if (!armed || !['settle-fails-three', 'after-settle'].includes(cut)) return;
        const record = await w.base.providerChange.findUnique({ where: { id: e.args.where.id } });
        if (record?.sub !== m || record.kind !== kind) return;
        if (++failures <= (cut === 'after-settle' ? 1 : 3)) throw new Error('synthetic settlement storage loss');
      });
      let effect;
      if (cut === 'before-effect' || cut === 'after-effect') effect = kind === 'end_session'
        ? holdEnd(P, cut === 'before-effect' ? 'before' : 'after') : holdAdmin('PUT ' + kind, cut === 'before-effect' ? 'before' : 'after', m);
      const sent = kc.endRequests.length + kc.adminCalls.filter(c => c.startsWith('PUT ')).length;
      let run;
      if (kind === 'end_session') run = w.call(w.I1, 'logout', { sid: await w.session(await w.issue(m, { sub: m, idp: P })) });
      else run = r10Patch(admin, m, { enabled: kind === 'enable' });
      if (effect) { await effect.arrived(); effect.release('drop'); }
      await run; await w.told();
      const records = await w.base.providerChange.findMany({ where: { sub: m, kind } });
      if (cut === 'before-record' || cut === 'after-record-before-commit') {
        assert.equal(records.length, 0, kind + '/' + cut + ': rolled back');
        assert.equal(kc.endRequests.length + kc.adminCalls.filter(c => c.startsWith('PUT ')).length, sent, 'nothing sent before committed intent');
      } else {
        assert.equal(records.length, 1);
        if (cut === 'after-settle') assert.equal(records[0].state, 'done', 'a committed answer survives sender loss');
        else {
          assert.equal(records[0].state, 'unknown', kind + '/' + cut + ': unknown survives');
          const restarted = w.instance('U4-' + m);
          // Recovery is a new instance over the same facts, never a guessed terminal state.
          const token = await w.issue(m + '-probe', { sub: m, idp: P });
          assert.equal((await w.call(restarted, 'get', { bearer: token.access })).status, 401);
          if (kind === 'end_session') assert.equal((await w.mark(P)).confirmedAt, null);
          else assert.ok(await r10Fact(w, m));
        }
      }
      if (cut === 'settle-fails-three') assert.equal(failures, 3, 'all three settlement attempts actually failed');
      armed = false;
    }
  }
  await w.finish('U4');
});

test('U5 SID-RETRY-STALE: confirmation and admission after retry CAS forbid a stale retry send', async t => {
  const w = await world(t, { now: START + 400 }), m = 'syn-u5', P = m + '-idp';
  const pending = holdEnd(P, 'before');
  await w.call(w.I1, 'logout', { sid: await w.session(await w.issue(m, { sub: m, idp: P })) }); await pending.arrived();
  const retry = w.instance('U5retry');
  const held = w.pause({ inst: 'U5retry', model: 'idpSessionEnd', method: 'updateMany', scope: 'root', phase: 'after' }, e => typeof e.args.data.attempts === 'number');
  retry.service.onModuleInit(); await held.arrived();
  pending.release(); await w.told(); await w.until('confirmed', async () => !!(await w.mark(P))?.confirmedAt);
  w.tick(1000); kc.ended = [];
  const entered = (await login(w, w.I2, await w.issue(m + '-new', { sub: m, idp: P, authTime: Date.now() / 1000 }))).done;
  assert.ok(entered.newSid); const calls = kc.endRequests.length;
  held.release(); await quiet(w); retry.service.onModuleDestroy();
  assert.equal(kc.endRequests.length, calls); await r10Survives(w, m, P, entered, m);
  await w.finish('U5');
});

test('U6 ABA-ENABLE-CLEAR: reused attempts on a recreated isolation never authorise old enable or clear', async t => {
  const w = await world(t), admin = r10Admin(w), other = r10Admin(w, w.I2);
  for (const edge of ['enable', 'clear']) {
    const m = r10Member('syn-u6-' + edge); await r10Patch(admin, m, { enabled: false });
    let ready = false, held;
    if (edge === 'enable') {
      w.observe({ inst: 'I1', model: 'providerChange', method: 'findFirst', phase: 'after' }, e => {
        if (e.args.where.sub === m && e.args.where.state === 'unknown' && !e.args.where.kind) ready = true;
      });
      held = w.pause({ inst: 'I1', model: '$transaction', phase: 'after' }, () => ready);
    } else {
      let enabled = false, taken = false;
      const previous = kc.onAdmin;
      const arrived = deferred(), release = deferred();
      kc.onAdmin = (name, sub) => {
        if (sub === m && name === 'PUT enable') enabled = true;
        if (sub === m && name === 'GET read' && enabled && !taken) { taken = true; arrived.resolve(); return release.promise; }
        return previous?.(name, sub);
      };
      held = { arrived: () => within(arrived.promise, 'enabled re-read'), release: () => release.resolve() };
    }
    const run = r10Patch(admin, m, { enabled: true }); await held.arrived();
    const old = await r10Fact(w, m);
    // Another activation clears the old fact; another suspension creates the next fact with a reused attempt number.
    assert.equal((await r10Patch(other, m, { enabled: true })).status, 200);
    assert.equal((await r10Patch(other, m, { enabled: false })).status, 200);
    const current = await r10Fact(w, m);
    // Aligning only the attempt counter makes the ABA explicit; epoch is assigned solely by PostgreSQL's sequence.
    await w.base.memberIsolation.update({ where: { sub: m }, data: { attempts: old.attempts } });
    assert.notEqual(current.epoch, old.epoch);
    const calls = kc.adminCalls.length; held.release(); const out = await run;
    assert.deepEqual([out.status, out.body?.code], [409, 'USER_ISOLATED']);
    assert.equal((await r10Fact(w, m)).epoch, current.epoch);
    assert.equal(kc.adminCalls.slice(calls).includes('PUT enable'), false);
    kc.onAdmin = null;
  }
  await w.finish('U6');
});

test('U7 APPROVAL-ENABLE-LOST: approve/cancel keep USER_ISOLATED, failure audit and entry blocking when enable reply is lost', async t => {
  const w = await world(t), admin = r10Admin(w);
  for (const cancel of [false, true]) {
    const m = r10Member('syn-u7-' + cancel);
    kc.onAdmin = name => name === 'PUT enable' ? 'drop' : undefined;
    const out = await r10Patch(admin, m, cancel ? { approvalState: 'PENDING' } : { institution: B, roles: ['clinician'] });
    assert.deepEqual([out.status, out.body?.code], [409, 'USER_ISOLATED']);
    assert.ok(await r10Fact(w, m));
    assert.equal(await w.base.auditLog.count({ where: { target: m, action: 'admin.user.patch.failed' } }), 1);
    const token = await w.issue(m, { sub: m, groups: cancel ? [] : [B], roles: cancel ? [] : ['clinician'] });
    assert.equal((await login(w, w.I2, token)).done.newSid, null);
    assert.equal((await w.call(w.I2, 'get', { bearer: token.access })).status, 401);
    kc.onAdmin = null;
  }
  await w.finish('U7');
});

test('U8 ROW-END-LAST-GAP: conditional row end rechecks ownership after its last outer check', async t => {
  const w = await world(t), admin = r10Admin(w), other = r10Admin(w, w.I2), m = r10Member('syn-u8'), P = m + '-idp';
  const old = await w.session(await w.issue(m, { sub: m, idp: P }));
  let rowsRead = false;
  w.observe({ inst: 'I1', model: 'authSession', method: 'findMany', scope: 'root', phase: 'after' }, e => {
    if (e.args.where?.sub === m && e.result.length) rowsRead = true;
  });
  const held = w.pause({ inst: 'I1', model: '$transaction', phase: 'before' }, () => rowsRead);
  const run = r10Patch(admin, m, { enabled: false }); await held.arrived();
  assert.equal((await r10Patch(other, m, { enabled: true })).status, 200);
  w.tick(1000); kc.ended = [];
  const entered = (await login(w, w.I2, await w.issue(m + '-new', { sub: m, idp: P, authTime: Date.now() / 1000 }))).done;
  assert.ok(entered.newSid); const sent = kc.endRequests.length;
  held.release(); assert.equal((await run).status, 409); await quiet(w);
  assert.equal(await w.version(old), null); assert.equal(kc.endRequests.length, sent);
  await r10Survives(w, m, P, entered, m); await w.finish('U8');
});

test('U9 UNKNOWN-GC-13H: old terminal records are collected; old unknown records and blocking survive', async t => {
  const w = await world(t), m = r10Member('syn-u9'), P = m + '-idp', at = new Date(Date.now() - 14 * HOUR);
  // A persisted call from a process no longer present: explicit storage fixture for restart/GC, not a provider answer.
  await w.base.memberIsolation.create({ data: { sub: m, decidedAt: at, nextAttemptAt: new Date(Date.now() + 2 * HOUR), providerDoneAt: at } });
  const unknown = await w.base.providerChange.create({ data: { sub: m, kind: 'enable', target: m, generation: 1, state: 'unknown', createdAt: at } });
  for (const state of ['done', 'void']) await w.base.providerChange.create({ data: { sub: m, kind: 'disable', target: m, generation: 1, state, createdAt: at, settledAt: at } });
  const sweeper = w.instance('U9gc'); sweeper.service.onModuleInit(); w.tick(HOUR);
  await w.until('terminal rows collected', async () => await w.base.providerChange.count({ where: { sub: m, state: { in: ['done', 'void'] } } }) === 0);
  sweeper.service.onModuleDestroy();
  assert.equal((await w.base.providerChange.findUnique({ where: { id: unknown.id } }))?.state, 'unknown');
  assert.ok(await r10Fact(w, m));
  assert.equal((await login(w, w.I2, await w.issue(m, { sub: m, idp: P }))).done.newSid, null);
  await w.finish('U9');
});

// U5S-REQ-06/09 + amendments 1/2 -> U5S-RISK-SESSION -> U5S-ENTRY-01/02.
test('U5S-ENTRY-01 callback delivers a single-use proof to the approved member final document', async t => {
  const w = await world(t);
  const vectors = [
    ['clinician', [A], ['clinician'], 'clinician.html', 200],
    ['defaults', ['/' + A], ['offline_access', 'clinician', 'default-roles-kin'], 'clinician.html', 200],
    ['reader', [A], ['radiologist'], 'main.html', 200],
    ['technician', [A], ['technician'], 'main.html', 200],
    ['admin', [A], ['admin'], 'main.html', 200],
    ['mixed-reader', [A], ['clinician', 'radiologist'], 'main.html', 200],
    ['mixed-tech', [A], ['clinician', 'technician'], 'main.html', 200],
    ['mixed-admin', [A], ['clinician', 'admin'], 'main.html', 200],
    ['pending', [], ['clinician'], 'main.html', 403],
    ['invalid', [A, B], ['clinician'], 'main.html', 403],
    ['no-role', [A], [], 'main.html', 403],
    ['nonstring-group', [7], ['clinician'], 'main.html', 403],
    ['gateway-mixed', [A], ['clinician', 'gateway'], 'main.html', 403],
  ];
  for (const [label, groups, roles, document, status] of vectors) {
    const sub = 'syn-entry-' + label;
    const { done } = await login(w, w.I1, await w.issue(label, { sub, groups, roles }));
    assert.equal(done.status, 302, label);
    const target = new URL(done.location);
    assert.equal(target.origin + target.pathname, ORIGIN + '/worklist/hpacs-lite/' + document, label);
    assert.equal(target.search, '', 'proof never rides in the query');
    assert.ok(done.proof && done.newSid, label);
    const entry = await w.call(w.I1, 'entry', { sid: done.newSid, body: { proof: done.proof } });
    assert.equal(entry.status, 200, label);
    const me = await w.call(w.I1, 'me', { sid: done.newSid, binding: entry.body.sessionId });
    assert.equal(me.status, status, label);
    if (status === 200) assert.deepEqual(me.body.roles, roles, label);
    assert.deepEqual(coded(await w.call(w.I2, 'entry', { sid: done.newSid, body: { proof: done.proof } })),
      [403, 'AUTH_ENTRY_REFUSED', 'AUTH_ENTRY_REFUSED'], label);
    assert.equal(rowsOf(await w.rows(), sub).filter(row => row.action === 'auth.entry').length, 1, label);
  }
  await w.finish('U5S-ENTRY-01');
});

test('U5S-ENTRY-02 bound me after proof consumption uses refreshed member roles, not the callback destination', async t => {
  const w = await world(t);
  for (const [label, before, after, groups, status] of [
    ['reader-to-clinician', ['radiologist'], ['clinician'], [A], 200],
    ['clinician-to-reader', ['clinician'], ['radiologist'], [A], 200],
    ['clinician-to-pending', ['clinician'], ['clinician'], [], 403],
    ['clinician-to-invalid', ['clinician'], ['clinician'], [A, B], 403],
  ]) {
    const sub = 'syn-entry-change-' + label;
    const { done } = await login(w, w.I1, await w.issue(label, { sub, roles: before, expIn: 1 }));
    assert.equal(new URL(done.location).pathname, '/worklist/hpacs-lite/'
      + (before.includes('clinician') ? 'clinician.html' : 'main.html'));
    w.tick(2_000);
    const next = await w.issue(label + '-next', { sub, roles: after, groups });
    kc.auto = () => reply.tokens(next);
    const entry = await w.call(w.I1, 'entry', { sid: done.newSid, body: { proof: done.proof } });
    assert.equal(entry.status, 200);
    const me = await w.call(w.I1, 'me', { sid: done.newSid, binding: entry.body.sessionId });
    assert.equal(me.status, status, label);
    if (status === 200) assert.deepEqual(me.body.roles, after, label);
    else assert.equal(me.body.code, groups.length ? 'INSTITUTION_INVALID' : 'INSTITUTION_PENDING', label);
    assert.equal(me.body.sessionId, entry.body.sessionId, label);
    kc.auto = null;
  }
  await w.finish('U5S-ENTRY-02');
});

// ── what reaches stdout/stderr while a world runs ──

const realWrite = { out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
const capture = { on: false, texts: [] };
function take(channel) {
  return (chunk, ...rest) => {
    if (capture.on && typeof chunk === 'string') { capture.texts.push([channel, chunk]); const done = rest.find(r => typeof r === 'function'); if (done) done(); return true; }
    return (channel === 'stdout' ? realWrite.out : realWrite.err)(chunk, ...rest);
  };
}
process.stdout.write = take('stdout');
process.stderr.write = take('stderr');
const report = line => realWrite.err('S7-U5-AUTH-SESSION ' + line + '\n');

// ── judges (AS-11 tests them first) ──

/** Kinds of secret or marker found in texts: the value itself never leaves this function. */
function secretHits(texts, secrets) {
  const found = new Set();
  for (const text of texts) {
    if (typeof text !== 'string' || !text) continue;
    for (const [kind, value] of secrets) {
      if (!value || value.length < 6) continue;
      if (text.includes(value) || text.includes(encodeURIComponent(value))) found.add(kind);
    }
  }
  return [...found].sort();
}

/** The secret entries of one value: the value, and for a JWT each of its dot-separated pieces. */
function secretEntries(kind, value) {
  const out = [[kind, value]];
  if (typeof value === 'string' && value.split('.').length === 3) value.split('.').forEach((piece, n) => out.push([kind + '-piece' + n, piece]));
  return out;
}

const DETAIL_KEYS = {
  'auth.login:success': ['dataSubject', 'institution', 'ip', 'outcome'],
  'auth.login:failure': ['cause', 'dataSubject', 'institution', 'ip', 'outcome'],
  'auth.logout': ['cause', 'dataSubject', 'institution', 'ip'],
  // A session ended by a re-authentication also says what asked for it (trigger: the declared reason, or register).
  'auth.logout:reauthentication': ['cause', 'dataSubject', 'institution', 'ip', 'trigger'],
  'auth.session.expired': ['cause', 'dataSubject', 'institution', 'ip'],
  'auth.entry': ['dataSubject', 'institution', 'ip'],
};
const shapeOf = row => row.action === 'auth.login'
  ? 'auth.login:' + row.detail.outcome
  : row.action === 'auth.logout' && row.detail.cause === 'reauthentication' ? 'auth.logout:reauthentication' : row.action;
// The login starts that carry an intent (POST /api/auth/login): what the landing declares.
const SWITCH = { intent: 'reauthenticate', reason: 'switch_account' };
const UNFINISHED = { intent: 'reauthenticate', reason: 'logout_unfinished' };
const UNTRUSTED = { intent: 'reauthenticate', reason: 'storage_untrusted' };
const UNREADABLE = { intent: 'reauthenticate', reason: 'record_unreadable' };

/** [action, cause or outcome, institution] of every auth row, sorted: order of commits is not the contract. */
const summary = rows => rows.map(r => [r.action, r.detail.cause ?? r.detail.outcome, r.detail.institution]).sort();

// ── a world: one empty database state, a fresh fake Keycloak state, two service instances ──

const { AuthService } = require('/app/dist/auth.service');
const { KeycloakService } = require('/app/dist/keycloak.service');
const { AuthGuard } = require('/app/dist/auth.guard');
const { AuthController } = require('/app/dist/auth.controller');
const { PacsController } = require('/app/dist/pacs.controller');

class SynProtectedController { read() {} }

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

async function world(t, { now = START } = {}) {
  const base = await database();
  await keycloak();
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now });
  await base.$executeRawUnsafe('TRUNCATE "AuthSession"');
  await base.$executeRawUnsafe('TRUNCATE "IdpSessionEnd"');
  await base.$executeRawUnsafe('TRUNCATE "MemberIsolation"');
  await base.$executeRawUnsafe('TRUNCATE "MemberCredential"');
  await base.$executeRawUnsafe('TRUNCATE "ProviderChange" RESTART IDENTITY');
  await base.$transaction([base.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    base.$executeRawUnsafe(`TRUNCATE "AuditLog" RESTART IDENTITY`)]);
  const [{ left }] = await base.$queryRawUnsafe(`SELECT (SELECT count(*) FROM "AuditLog") + (SELECT count(*) FROM "AuthSession") + (SELECT count(*) FROM "IdpSessionEnd") + (SELECT count(*) FROM "MemberIsolation") + (SELECT count(*) FROM "ProviderChange") AS left`);
  assert.equal(Number(left), 0, 'every world starts with no session, no end mark, no isolation fact, no provider change record and no audit row');
  Object.assign(kc, { held: [], waiters: [], auto: null, logoutMode: 'ok', onLogout: null, logouts: 0, tokens: 0, codes: [],
    certs: 'ok', certRequests: 0, abandoned: 0, ended: [], alive: null, serviceTokens: 0, serviceMode: 'ok', endRequests: [],
    members: {}, userLogouts: [], adminDown: false, adminFail: {}, adminCalls: [], onAdmin: null, beforeAdmin: null,
    beforeEnd: null, afterEnd: null, hung: [], adminStale: {}, adminRefuse: {}, transportTimeoutMs: 0 });
  idp.started = 0;

const w ={ t, base, calls: [], gates: [], faults: [], secrets: [], labels: new Map(), rejections: [], observations: [] };
  // Store-operation boundaries, independent of service method names or implementation text. Hooks may observe or hold
  // an actual Prisma statement before/after it executes; PG cases still use real transactions and real connections.
  w.observe = (match, work) => w.observations.push({ match, work });
  const observe = async event => {
    for (const hook of w.observations)
      if (Object.entries(hook.match).every(([k, v]) => event[k] === v)) await hook.work(event);
  };
  w.pause = (match, predicate = () => true) => {
    const arrived = deferred(), release = deferred(); let taken = false;
    w.observe(match, async event => { if (!taken && predicate(event)) { taken = true; arrived.resolve(event); await release.promise; } });
    t.after(() => release.resolve());
    return { arrived: () => within(arrived.promise, 'store boundary'), release: () => release.resolve() };
  };
  w.secret = (kind, value) => { for (const entry of secretEntries(kind, value)) w.secrets.push(entry); };
  w.secret('client-secret', SECRETS.client);
  w.secret('cookie-secret', SECRETS.cookie);
  w.secret('service-secret', SECRETS.service);
  w.secret('service-token', SECRETS.serviceToken);

  // A gate holds an instance before it runs the named point; a fault makes the named point throw once.
  w.gate = (inst, point) => {
    const gate = { inst, point, used: false, arrived: deferred(), release: deferred() };
    w.gates.push(gate);
    return { arrived: () => within(gate.arrived.promise, `${inst} reaching ${point}`), release: () => gate.release.resolve() };
  };
  w.fault = (inst, point, error) => { w.faults.push({ inst, point, error }); };
  async function hit(inst, point) {
    w.calls.push(inst + ':' + point);
    const gate = w.gates.find(g => g.inst === inst && g.point === point && !g.used);
    if (gate) { gate.used = true; gate.arrived.resolve(); await gate.release.promise; }
    const n = w.faults.findIndex(f => f.inst === inst && f.point === point);
    if (n >= 0) { const [fault] = w.faults.splice(n, 1); throw fault.error; }
  }
  // Points: read, sweepRead, store (a refresh's token write), touch, tx.open, tx.delete, tx.create, tx.audit, audit; and
  // of the end mark (IdpSessionEnd): tx.mark (the end's write), tx.markRead (the callback's check), tx.markWake, and
  // outside a transaction mark.<method> (the confirmation and retry writes, the Bearer path's read).
  const pointOf = (scope, model, method, args) => {
    if (model === 'memberIsolation' || model === 'memberCredential' || model === 'providerChange') return model + '.' + method;
    if (model === 'auditLog') return scope === 'tx' ? 'tx.audit' : 'audit';
    if (model === 'idpSessionEnd')
      return scope !== 'tx' ? 'mark.' + method : method === 'upsert' ? 'tx.mark' : method === 'findUnique' ? 'tx.markRead' : 'tx.markWake';
    if (scope === 'tx') return method === 'deleteMany' ? 'tx.delete' : method === 'create' ? 'tx.create' : 'tx.' + method;
    if (method === 'findUnique') return 'read';
    if (method === 'findMany') return args?.select?.sid ? 'admissions' : 'sweepRead';
    if (method === 'updateMany') return Object.keys(args?.data ?? {}).join() === 'lastSeenAt' ? 'touch' : 'store';
    return method;
  };
  const delegate = (inst, client, model, scope) => new Proxy({}, { get(_target, method) {
    const real = client[model][method];
    if (typeof real !== 'function') return real;
    return async args => {
      if (['authSession', 'auditLog', 'idpSessionEnd'].includes(model)) await hit(inst, pointOf(scope, model, method, args));
      await observe({ inst, scope, model, method, args, phase: 'before' });
      const result = await real.call(client[model], args);
      await observe({ inst, scope, model, method, args, result, phase: 'after' });
      return result;
    };
  } });
  const recorder = inst => new Proxy({}, { get(_target, key) {
    if (key === '$transaction') return async (fn, options) => {
      await hit(inst, 'tx.open');
      await observe({ inst, model: '$transaction', phase: 'before' });
      const result = await base.$transaction(async tx => {
        w.calls.push(inst + ':tx:start');
        const view = new Proxy({}, { get(_t, k) {
          if (['authSession', 'auditLog', 'idpSessionEnd', 'memberIsolation', 'memberCredential', 'providerChange'].includes(k)) return delegate(inst, tx, k, 'tx');
          const value = tx[k];
          return typeof value === 'function' ? value.bind(tx) : value;
        } });
        const out = await fn(view);
        w.calls.push(inst + ':tx:end');
        return out;
      }, options);
      await observe({ inst, model: '$transaction', phase: 'after', result });
      return result;
    };
    if (['authSession', 'auditLog', 'idpSessionEnd', 'memberIsolation', 'memberCredential', 'providerChange'].includes(key)) return delegate(inst, base, key, 'root');
    const value = base[key];
    return typeof value === 'function' ? value.bind(base) : value;
  } });
  const make = name => {
    // The product's own Keycloak admin client, over the fake's address: each instance its own (its own service token).
    // `prisma` is the instance's recording view, for the other product services a case builds over the same instance.
    const prisma = recorder(name);
    const service = new AuthService(prisma, new KeycloakService());
    return { name, service, prisma, guard: new AuthGuard(new Reflector(), service), controller: new AuthController(service), handled: 0 };
  };
  w.I1 = make('I1');
  w.I2 = make('I2');
  /** Another process over the same database: nothing of the others' memory (key set, shared refreshes). */
  w.instance = make;

  // The real Nest exception path, with only its transport replaced by an in-memory response.
  const adapter = {
    reply(res, body, status) { res.statusCode = status; res.body = body; res.sent = true; },
    isHeadersSent: res => !!res.sent,
    end(res) { res.sent = true; },
  };
  w.exceptions = new ExceptionsHandler(adapter);

  /**
   * One request through the compiled guard and controller (or the protected test handler).
   *
   * A cookie request carries the binding a document of that session holds (X-KIN-Session = the session's own id, the
   * value `GET me` hands out; computed with the service's pure derivation, which the guard itself calls) unless the case
   * gives another (`binding: null` sends none, a string sends that value). The bootstrap `me`, the entry proof and the
   * link logins are the requests a document makes before it knows the id: they send none by default.
   */
  w.call = async (inst, kind, { sid, cookie, ip = IP, headers = {}, query = {}, body, bearer, binding, csrf = true } = {}) => {
    const routes = {
      get: ['GET', '/api/syn/protected', SynProtectedController, SynProtectedController.prototype.read],
      me: ['GET', '/api/me', PacsController, PacsController.prototype.me],
      authz: ['GET', '/api/authz/dicom', PacsController, PacsController.prototype.authzDicom],
      logout: ['POST', '/api/auth/logout', AuthController, AuthController.prototype.logout],
      login: ['GET', '/api/auth/login', AuthController, AuthController.prototype.login],
      register: ['GET', '/api/auth/register', AuthController, AuthController.prototype.register],
      switch: ['POST', '/api/auth/login', AuthController, AuthController.prototype.startLogin],
      signup: ['POST', '/api/auth/register', AuthController, AuthController.prototype.startRegister],
      entry: ['POST', '/api/auth/entry', AuthController, AuthController.prototype.entry],
      callback: ['GET', '/api/auth/callback', AuthController, AuthController.prototype.callback],
    };
    const [method, path, cls, handler] = routes[kind];
    const cookies = [sid ? 'kin_sid=' + encodeURIComponent(sid) : null, cookie ?? null].filter(Boolean).join('; ');
    const unbound = ['me', 'entry', 'login', 'register', 'callback'].includes(kind);
    const bound = binding === undefined ? (sid && !unbound ? inst.service.sessionRef(sid) : null) : binding;
    const req = { method, originalUrl: path, url: path, query, body, headers: {
      ...(cookies ? { cookie: cookies } : {}), ...(ip === null ? {} : { 'x-real-ip': ip }),
      ...(method === 'POST' && csrf ? { 'x-kin-csrf': '1' } : {}), ...(bound ? { 'x-kin-session': bound } : {}),
      ...(bearer ? { authorization: 'Bearer ' + bearer } : {}), ...headers } };
    const res = { req, setCookies: [], sentHeaders: {}, headersSent: false, statusCode: null, body: undefined, location: null, sent: false,
      append(name, value) { if (name === 'Set-Cookie') this.setCookies.push(value); },
      setHeader(name, value) { this.sentHeaders[String(name).toLowerCase()] = value; },
      redirect(status, url) { this.statusCode = status; this.location = url; this.sent = true; },
      status(code) { this.statusCode = code; return this; },
      send(body) { this.body = body; this.sent = true; return this; } };
    try {
      await inst.guard.canActivate(new ExecutionContextHost([req, res], cls, handler));
      if (kind === 'get') { inst.handled++; res.status(200).send({ ok: true }); }
      else if (kind === 'authz') { inst.handled++; res.status(204).send(); }
      else if (kind === 'me') res.status(200).send(new PacsController(null).me(req));
      else if (kind === 'logout') await inst.controller.logout(req, res);
      else if (kind === 'login') await inst.controller.login(req, res, query.prompt);
      else if (kind === 'register') await inst.controller.register(req, res);
      else if (kind === 'switch') res.status(200).send(await inst.controller.startLogin(req, res, body));
      else if (kind === 'signup') res.status(200).send(await inst.controller.startRegister(req, res));
      else if (kind === 'entry') res.status(200).send(await inst.controller.entry(req, res));
      else await inst.controller.callback(req, res, query.code, query.state, query.error);
    } catch (error) {
      w.exceptions.next(error, new ExecutionContextHost([req, res]));
    }
    const set = name => res.setCookies.filter(c => c.startsWith(name + '='));
    // A pending login is one cookie per flow (kin_pending_<derived from its state>): `pending` is the value of the flow
    // this answer started, `pendingCookie` that cookie as a browser sends it back, `consumed` the flow cookies it expired.
    const sidCookie = set('kin_sid'), pending = res.setCookies.filter(c => c.startsWith('kin_pending_'));
    const value = c => decodeURIComponent(c.slice(c.indexOf('=') + 1, c.indexOf(';')));
    const started = pending.filter(c => !/Max-Age=0/.test(c));
    const out = {
      status: res.statusCode, body: res.body, location: res.location ?? res.body?.location ?? null,
      authCode: res.sentHeaders['x-kin-auth-code'] ?? null,
      expired: sidCookie.some(c => c.startsWith('kin_sid=;') || /Max-Age=0/.test(c)),
      newSid: sidCookie.filter(c => !/Max-Age=0/.test(c)).map(value)[0] ?? null,
      pending: started.map(value)[0] ?? null,
      pendingCookie: started.map(c => c.slice(0, c.indexOf(';')))[0] ?? null,
      consumed: pending.filter(c => /Max-Age=0/.test(c)).map(c => c.slice(0, c.indexOf('='))),
      sidCookies: sidCookie.length, texts: [JSON.stringify(res.body ?? null), res.location ?? '', ...res.setCookies],
    };
    // What the answer does to the browser's cookies: E = it expires kin_sid (no answer may), S = a new kin_sid (the login
    // callback only), P = a new pending login and kin_sid untouched, K = kin_sid untouched.
    out.cookie = out.expired ? (out.pending ? 'P' : 'E') : out.newSid ? 'S' : out.pending ? 'P' : 'K';
    if (out.expired) w.expiries.push(kind);
    if (out.newSid) w.secret('sid', out.newSid);
    if (out.pending) w.secret('pending', out.pending);
    const fragment = /#kin-entry=([^&]+)/.exec(out.location ?? '');
    if (fragment) { out.proof = decodeURIComponent(fragment[1]); w.secret('proof', out.proof); }
    w.responses.push(out.texts);
    return out;
  };
  w.responses = [];
  w.expiries = [];

  /** A token version: a signed access token (RS256, the fake Keycloak's key) and an opaque refresh token. */
  /**
   * `idp` is the provider session the token belongs to (its `sid` claim). Every token of one account is of one provider
   * session unless the case names another - a refresh continues its session's provider session, and two logins of one
   * browser share its SSO; a case about two PCs, or about sessions that must end apart, names them. `idp: null` issues
   * a token without the claim. `authTime` (seconds, as Keycloak truncates it) is the `auth_time` claim: when the provider
   * authenticated that SSO; without it the token carries none (U5E-21 is the case about it).
   */
  w.issue = async (label, { sub, groups = [A], email, roles = ['radiologist'], expIn = HOUR / 1000, key = 'main', same, idp, authTime } = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const jti = label + '-' + randomUUID();
    const sid = idp === undefined ? 'syn-idp-' + sub : idp;
    const access = await new jose.SignJWT({ email: email ?? sub + '@synthetic.test', groups, realm_access: { roles }, azp: 'kin-bff', jti,
      ...(sid === null ? {} : { sid }), ...(authTime === undefined ? {} : { auth_time: authTime }) })
      .setProtectedHeader({ alg: 'RS256', kid: KEYS[key].kid }).setIssuer(ISSUER).setAudience('kin-api').setSubject(sub)
      .setIssuedAt(now).setExpirationTime(same?.exp ?? now + expIn).sign(KEYS[key].privateKey);
    const v = { label, sub, access, refresh: 'syn-rt-' + randomUUID(), jti, exp: same?.exp ?? now + expIn, idp: sid };
    w.labels.set(jti, label);
    w.secret('access', v.access);
    w.secret('refresh', v.refresh);
    return v;
  };
  /**
   * A session row put by the harness (never the race's own version: those the product stores), as a login of that token
   * stores it - with the token's provider session. `legacy: true` leaves the column empty: a row from before the column.
   */
  w.session = async (v, { lastSeenAt = new Date(), atExpiresAt = new Date(v.exp * 1000 - 30_000), legacy = false } = {}) => {
    const sid = randomBytes(32).toString('base64url');
    w.secret('sid', sid);
    await base.authSession.create({ data: { sid, sub: v.sub, accessToken: v.access, refreshToken: v.refresh, atExpiresAt, lastSeenAt,
      idpSid: legacy ? null : v.idp } });
    return sid;
  };
  /** The end marks: [provider session, cause, confirmed?] sorted, and one mark's row. */
  w.marks = async () => (await base.idpSessionEnd.findMany()).map(m => [m.idpSid, m.cause, m.confirmedAt !== null]).sort();
  w.mark = idp => base.idpSessionEnd.findUnique({ where: { idpSid: idp } });
  /** The states of the provider change records (ProviderChange) of one target (a provider session or a member), in order. */
  w.changes = async (target, kind) => (await base.providerChange.findMany({ where: kind ? { target, kind } : { target }, orderBy: { id: 'asc' } }))
    .map(row => row.state);
  /** The version label left in the session (or null), compared by jti - no token value is printed. */
  w.version = async sid => {
    const row = await base.authSession.findUnique({ where: { sid } });
    return row ? w.labels.get(jose.decodeJwt(row.accessToken).jti) ?? 'unknown' : null;
  };
  w.lastSeen = async sid => (await base.authSession.findUnique({ where: { sid } }))?.lastSeenAt.getTime() ?? null;
  w.sessions = async () => base.authSession.count();
  w.rows = async () => (await base.auditLog.findMany({ where: { action: { in: AUTH_ACTIONS } }, orderBy: { id: 'asc' } }))
    .map(r => ({ actor: r.actor, action: r.action, target: r.target, detail: JSON.parse(r.detail) }));
  w.ends = async () => summary((await w.rows()).filter(r => r.action !== 'auth.login'));
  w.tick = ms => t.mock.timers.tick(ms);
  /**
   * The count of Keycloak logout requests once `expected` have arrived (or what arrived within the wait). A logout
   * answers when the session is revoked and recorded; Keycloak is told afterwards, without the answer waiting for it.
   */
  w.told = async () => {
    const until = performance.now() + 5_000;
    // An end is told after its answer (a store write, then the request) and confirmed after Keycloak's answer (another
    // write): quiet means nothing open and nothing newly started for a moment.
    for (let seen = -1; performance.now() < until;) {
      if (idp.open === 0 && seen === idp.started) break;
      seen = idp.open === 0 ? idp.started : -1;
      await new Promise(resolve => setTimeout(resolve, idp.open === 0 ? 120 : 10));
    }
    return kc.logouts;
  };

  /** Waits (real time) until the predicate on the database holds: a sweep has no response to wait for. */
  w.until = async (what, predicate) => {
    const until = performance.now() + 10_000;
    for (;;) {
      if (await predicate()) return;
      if (performance.now() > until) throw new Error('harness: ' + what + ' not observed within 10 s');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };

  capture.on = true;
  capture.texts = [];
  /** World end (AS-10 a): every auth row has its exact key set; no secret in rows, responses or captured output. */
  w.finish = async (name, { output = [] } = {}) => {
    // Every provider end request this world started has been answered or given up: a telling does not hold its end's
    // answer, so the world waits for the stragglers here instead of leaving them to the next world's counters.
    await w.told();
    assert.equal(idp.open, 0, `${name}: every provider end request started was answered or given up`);
    capture.on = false;
    const rows = await w.rows();
    for (const row of rows) {
      assert.deepEqual(Object.keys(row.detail).sort(), DETAIL_KEYS[shapeOf(row)], `${name}: detail keys of ${row.action}`);
      assert.equal(row.detail.dataSubject, null, `${name}: dataSubject is recorded as null`);
    }
    const raw = await base.auditLog.findMany({ where: { action: { in: AUTH_ACTIONS } } });
    const columns = raw.flatMap(r => [r.actor, r.action, r.target, r.detail]);
    const outputTexts = capture.texts.map(([, text]) => text);
    // Responses carry the session and pending cookies and the Keycloak redirect by design; they are checked for the
    // DB error markers (AS-10 b), not for the secrets they are meant to hand the browser.
    const hits = { rows: secretHits(columns, w.secrets), output: secretHits(outputTexts, w.secrets) };
    const extra = output.length ? secretHits(outputTexts, output) : [];
    report(JSON.stringify({ case: name, rows: rows.length, hits: [...hits.rows, ...hits.output, ...extra],
      captured: capture.texts.length }));
    assert.deepEqual(hits, { rows: [], output: [] }, `${name}: secrets found (kinds only)`);
    // U5S-REQ-10: no answer of this world expired or overwrote kin_sid; the only kin_sid an answer sets is a login's.
    assert.deepEqual(w.expiries, [], `${name}: answers that expired kin_sid`);
    assert.deepEqual(extra, [], `${name}: markers found in the output (kinds only)`);
    return capture.texts;
  };
  return w;
}

async function within(promise, what, ms = 10_000) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('harness: ' + what + ' did not happen')), ms); });
  try { return await Promise.race([promise, timeout]); }
  finally { clearTimeout(timer); }
}

/** A full browser login through the compiled controller: login -> fake Keycloak code -> callback. */
async function login(w, inst, v, { ip = IP } = {}) {
  const begin = await w.call(inst, 'login');
  assert.equal(begin.status, 302);
  const state = new URL(begin.location).searchParams.get('state');
  w.secret('state', state);
  const done = await answerFlow(w, inst, begin, v, { ip });
  return { begin, done, state, pending: begin.pending };
}

/** The provider answers a started flow with a code for token version v: the browser comes back to the callback. */
async function answerFlow(w, inst, begin, v, { ip = IP, sid, cookies = [] } = {}) {
  const state = new URL(begin.location).searchParams.get('state');
  w.secret('state', state);
  const code = 'syn-code-' + randomUUID();
  w.secret('code', code);
  kc.auto = form => form.grant_type === 'authorization_code' ? reply.tokens(v) : reply.reject();
  const done = await w.call(inst, 'callback', { sid, cookie: [begin.pendingCookie, ...cookies].join('; '), ip, query: { code, state } });
  kc.auto = null;
  for (const entry of kc.codes) w.secret('verifier', entry.verifier);
  return done;
}

/** The provider answers a started flow with an error (prompt=none without an SSO session: login_required). */
function refuseFlow(w, inst, begin, error, { cookies = [] } = {}) {
  const state = new URL(begin.location).searchParams.get('state');
  w.secret('state', state);
  return w.call(inst, 'callback', { cookie: [begin.pendingCookie, ...cookies].join('; '), query: { error, state } });
}

const promptOf = out => new URL(out.location).searchParams.get('prompt');
const atProvider = out => typeof out.location === 'string' && out.location.startsWith(ISSUER + '/protocol/openid-connect/auth?');
const landing = error => ORIGIN + '/worklist/hpacs-lite/index.html?auth_error=' + error;

const rowsOf = (rows, target) => rows.filter(r => r.target === target);

// ── AS-11: the judges themselves ──

test('AS-11 the judges: secret hits, output channels, row sets and session versions', async () => {
  const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzeW4ifQ.c2lnbmF0dXJlLXN5bg';
  const secrets = [...secretEntries('access', jwt), ['sid', 'SYN-SID-0123456789'], ['marker', 'SYN-MARK-MSG-X']];
  assert.deepEqual(secretHits(['a SYN-SID-0123456789 b'], secrets), ['sid']);
  assert.deepEqual(secretHits([encodeURIComponent('x/SYN-SID-0123456789+')], secrets), ['sid']);
  assert.deepEqual(secretHits(['only eyJzdWIiOiJzeW4ifQ here'], secrets), ['access-piece1']);
  assert.deepEqual(secretHits(['SYN-MARK-MSG-X'], secrets), ['marker']);
  assert.deepEqual(secretHits(['nothing of the kind', '', null], secrets), []);
  // The channel collector takes string writes of stdout and stderr and passes buffers through.
  capture.on = true;
  capture.texts = [];
  process.stdout.write('SYN-MARK-MSG-X on stdout\n');
  process.stderr.write('clean stderr\n');
  capture.on = false;
  assert.deepEqual(capture.texts.map(([channel, text]) => [channel, secretHits([text], secrets)]),
    [['stdout', ['marker']], ['stderr', []]]);
  // Row-set comparison: one missing, one extra, one field different are mismatches; order alone is not.
  const rows = [{ action: 'auth.logout', detail: { cause: 'logout', institution: A } },
    { action: 'auth.session.expired', detail: { cause: 'idle', institution: B } }];
  assert.deepEqual(summary(rows), summary([...rows].reverse()));
  assert.notDeepEqual(summary(rows), summary(rows.slice(1)));
  assert.notDeepEqual(summary(rows), summary([...rows, rows[0]]));
  assert.notDeepEqual(summary(rows), summary([rows[0], { ...rows[1], detail: { cause: 'idle', institution: A } }]));
  // Detail key sets.
  assert.deepEqual(Object.keys({ institution: A, ip: IP, dataSubject: null, cause: 'logout' }).sort(), DETAIL_KEYS['auth.logout']);
  assert.notDeepEqual(Object.keys({ institution: A, ip: IP, dataSubject: null, cause: 'logout', sid: 'x' }).sort(), DETAIL_KEYS['auth.logout']);
});

/** What the compiled guard decides from one access token (Bearer): req.actor, req.sub, req.institution. */
async function guardView(w, access) {
  const req = { method: 'GET', originalUrl: '/api/syn/protected', url: '/api/syn/protected', headers: { authorization: 'Bearer ' + access } };
  try {
    await w.I1.guard.canActivate(new ExecutionContextHost([req, { req }], SynProtectedController, SynProtectedController.prototype.read));
  } catch (_) { /* a PENDING or INVALID member is refused after the guard has read the token */ }
  return { actor: req.actor, sub: req.sub, institution: req.institution ?? null };
}

const past = (ms = 1000) => new Date(Date.now() - ms);
/** A stored atExpiresAt whose token has really expired (the lead is over): a request must wait for the refresh. */
const lapsed = () => past(LEAD + 1000);

// ── AS-01..AS-07 ──

test('AS-01 a login writes its session and one success row in one transaction', async t => {
  const w = await world(t);
  const v = await w.issue('ma', { sub: 'syn-sub-ma', groups: ['/' + A], email: 'syn-ma@synthetic.test' });
  const first = await login(w, w.I1, v);
  assert.deepEqual([first.done.status, first.done.location.split('#kin-entry=')[0], !!first.done.proof, !!first.done.newSid],
    [302, ORIGIN + '/worklist/hpacs-lite/main.html', true, true], 'the callback is the one answer that sets kin_sid; the entry proof rides in the fragment');
  assert.equal(await w.sessions(), 1);
  assert.deepEqual(await w.rows(), [{ actor: 'syn-ma@synthetic.test', action: 'auth.login', target: 'syn-sub-ma',
    detail: { institution: A, ip: IP, dataSubject: null, outcome: 'success' } }]);
  const start = w.calls.indexOf('I1:tx:start');
  assert.deepEqual(w.calls.slice(start, w.calls.indexOf('I1:tx:end', start) + 1),
    ['I1:tx:start', 'I1:tx.markRead', 'I1:tx.create', 'I1:tx.audit', 'I1:tx:end'],
    'the end mark of the provider session is read, then the session and its row are written, in one transaction');
  // Preserving pair: the same member again - a session and a row per login.
  await login(w, w.I1, await w.issue('ma2', { sub: 'syn-sub-ma', groups: ['/' + A], email: 'syn-ma@synthetic.test' }));
  assert.equal(await w.sessions(), 2);
  assert.deepEqual(summary(await w.rows()), [['auth.login', 'success', A], ['auth.login', 'success', A]]);
  await w.finish('AS-01');
});

test('AS-02 the record-time institution is the token\'s one group, as the guard decides it, on login, logout and idle', async t => {
  const w = await world(t);
  const vectors = [['one group with a slash', ['/' + A], ['radiologist'], A], ['no group (PENDING)', [], ['radiologist'], null],
    ['two groups (INVALID)', [A, B], ['radiologist'], null], ['one group, no role (INVALID)', [A], [], A], ['a number', [7], ['radiologist'], null],
    ['one group without a slash', [B], ['radiologist'], B]];
  let n = 0;
  for (const [label, groups, roles, expected] of vectors) {
    const sub = 'syn-sub-v' + (++n);
    const v = await w.issue('login-' + n, { sub, groups, roles });
    assert.equal((await guardView(w, v.access)).institution, expected, label + ': the guard rule');
    await login(w, w.I1, v);
    // Three logins of one account on three PCs (three provider sessions): each ends by itself.
    const out = await w.call(w.I1, 'logout', { sid: await w.session(await w.issue('out-' + n, { sub, groups, roles, idp: 'syn-idp-out-' + n })) });
    assert.equal(out.status, 204, label);
    const idle = await w.call(w.I1, 'get', { sid: await w.session(await w.issue('idle-' + n, { sub, groups, roles, idp: 'syn-idp-idle-' + n }),
      { lastSeenAt: past(IDLE + 60_000) }) });
    assert.equal(idle.status, 401, label);
    assert.deepEqual(rowsOf(await w.rows(), sub).map(r => [r.action, r.detail.cause ?? r.detail.outcome, r.detail.institution]),
      [['auth.login', 'success', expected], ['auth.logout', 'logout', expected], ['auth.session.expired', 'idle', expected]], label);
  }
  await w.finish('AS-02');
});

test('AS-03 a failed login of a login this server started leaves one failure row; anything else none', async t => {
  const w = await world(t);
  const count = async () => (await w.rows()).length;
  const begin = async () => {
    const out = await w.call(w.I1, 'login');
    const state = new URL(out.location).searchParams.get('state');
    w.secret('state', state);
    return { pending: out.pendingCookie, state };
  };
  const failure = cause => ({ actor: 'unknown', action: 'auth.login', target: '',
    detail: { institution: null, ip: IP, dataSubject: null, outcome: 'failure', cause } });
  const last = async () => (await w.rows()).at(-1);
  let p = await begin();
  let out = await w.call(w.I1, 'callback', { cookie: p.pending, query: { error: 'access_denied', state: p.state } });
  assert.equal(out.location, ORIGIN + '/worklist/hpacs-lite/index.html?auth_error=access_denied');
  assert.deepEqual(await last(), failure('provider_error'));
  p = await begin();
  await w.call(w.I1, 'callback', { cookie: p.pending, query: { error: 'temporarily_unavailable', state: p.state } });
  assert.deepEqual(await last(), failure('provider_error'), 'another error value: the same row, no error text');
  p = await begin();
  // A callback whose state is not a flow of this browser while a login this server started is pending (A010): the code
  // is not exchanged, the row is written, and - the browser has no session - the login is started again once, never a
  // JSON error page. The restarted flow's own stray callback is not restarted again.
  let exchanged = kc.tokens;
  out = await w.call(w.I1, 'callback', { cookie: p.pending, query: { code: 'syn-code-x', state: 'syn-other-state' } });
  assert.deepEqual([out.status, atProvider(out), out.body, kc.tokens - exchanged, out.consumed], [302, true, undefined, 0, []],
    'restarted at the provider; the pending flow of the other tab is not consumed');
  assert.deepEqual(await last(), failure('state_mismatch'));
  const restarted = new URL(out.location).searchParams.get('state');
  w.secret('state', restarted);
  out = await w.call(w.I1, 'callback', { query: { code: 'syn-code-x2', state: restarted } });
  assert.deepEqual([out.status, out.location, kc.tokens - exchanged], [302, landing('stale'), 0], 'the second stray callback goes to the landing');
  p = await begin();
  out = await w.call(w.I1, 'callback', { cookie: p.pending, query: { state: p.state } });
  assert.equal(out.location, ORIGIN + '/worklist/hpacs-lite/index.html?auth_error=stale');
  assert.deepEqual(await last(), failure('no_code'));
  p = await begin();
  kc.auto = () => reply.reject();
  out = await w.call(w.I1, 'callback', { cookie: p.pending, query: { code: 'syn-code-y', state: p.state } });
  assert.equal(out.location, ORIGIN + '/worklist/hpacs-lite/index.html?auth_error=login_failed');
  assert.deepEqual(await last(), failure('exchange_failed'));
  // A token the fake Keycloak signed with another key: verification fails, and its email and groups are not used.
  const forged = await w.issue('forged', { sub: 'syn-sub-forged', groups: [A], email: 'syn-forged@synthetic.test', key: 'other' });
  p = await begin();
  kc.auto = () => reply.tokens(forged);
  out = await w.call(w.I1, 'callback', { cookie: p.pending, query: { code: 'syn-code-z', state: p.state } });
  kc.auto = null;
  assert.equal(out.location, ORIGIN + '/worklist/hpacs-lite/index.html?auth_error=login_failed');
  assert.deepEqual(await last(), failure('token_invalid'));
  assert.equal(await w.sessions(), 0);
  const before = await count();
  // No row without a login this server started: no pending, a forged signature, an expired one.
  for (const query of [{ error: 'access_denied' }, { code: 'syn-c', state: 'syn-s' }, {}])
    await w.call(w.I1, 'callback', { query });
  p = await begin();
  const tampered = p.pending.slice(0, -2) + (p.pending.endsWith('A') ? 'BB' : 'AA');
  await w.call(w.I1, 'callback', { cookie: tampered, query: { error: 'access_denied', state: p.state } });
  p = await begin();
  // A flow is good for as long as the provider's login form is (30 min): at 29 min it still fails as its own flow ...
  w.tick(29 * 60_000);
  out = await w.call(w.I1, 'callback', { cookie: p.pending, query: { state: p.state } });
  assert.deepEqual([out.location, (await last()).detail.cause, await count()], [landing('stale'), 'no_code', before + 1]);
  // ... and past it, it is no longer a login this server vouches for: no row.
  p = await begin();
  w.tick(31 * 60_000);
  await w.call(w.I1, 'callback', { cookie: p.pending, query: { error: 'access_denied', state: p.state } });
  exchanged = kc.tokens;
  out = await w.call(w.I1, 'callback', { cookie: p.pending, query: { code: 'syn-c', state: p.state } });
  assert.deepEqual([out.status, atProvider(out), kc.tokens - exchanged], [302, true, 0], 'an expired own flow is started again, its code unused');
  // A browser that already has a session: a callback without code is not a login event.
  const sid = await w.session(await w.issue('has', { sub: 'syn-sub-has' }));
  out = await w.call(w.I1, 'callback', { sid, query: {} });
  assert.equal(out.location, ORIGIN + '/worklist/hpacs-lite/main.html');
  assert.equal(await count(), before + 1, 'no pending, a forged or expired pending, or a session callback: no row');
  await w.finish('AS-03');
});

test('AS-04 logout: one row from the ended session, Bearer none, overlap one, a guard end its own cause', async t => {
  const w = await world(t);
  // (a) the row's actor, target and institution are the stored token's - the guard's own reading of it.
  const va = await w.issue('a', { sub: 'syn-sub-a', groups: [A] });
  let out = await w.call(w.I1, 'logout', { sid: await w.session(va) });
  assert.deepEqual([out.status, out.cookie], [204, 'K']);
  const seen = await guardView(w, va.access);
  assert.deepEqual(rowsOf(await w.rows(), 'syn-sub-a'), [{ actor: seen.actor, action: 'auth.logout', target: seen.sub,
    detail: { institution: seen.institution, ip: IP, dataSubject: null, cause: 'logout' } }]);
  // (b) Keycloak's logout endpoint cuts the connection: the local end still happens, Keycloak was asked once.
  kc.logoutMode = 'drop';
  const logouts = kc.logouts;
  out = await w.call(w.I1, 'logout', { sid: await w.session(await w.issue('b', { sub: 'syn-sub-b', groups: [B] })) });
  // (a cut connection may be tried again by the HTTP client within the request's bound: asked at least once)
  assert.deepEqual([out.status, out.cookie, await w.told() - logouts >= 1], [204, 'K', true]);
  kc.logoutMode = 'ok';
  assert.deepEqual(summary(rowsOf(await w.rows(), 'syn-sub-b')), [['auth.logout', 'logout', B]]);
  // (c) two logouts of one session overlap (RT-12), in both orders: the one that deleted writes the row.
  for (const [first, second, sub] of [[w.I1, w.I2, 'syn-sub-c1'], [w.I2, w.I1, 'syn-sub-c2']]) {
    const sid = await w.session(await w.issue(sub, { sub, groups: [A] }));
    const gate = w.gate(first.name, 'tx.open');
    const held = w.call(first, 'logout', { sid });
    await gate.arrived();
    const won = await w.call(second, 'logout', { sid });
    gate.release();
    const lost = await held;
    assert.deepEqual([won.status, won.cookie, lost.status, lost.cookie], [204, 'K', 204, 'K'], sub);
    const after = await w.call(first, 'logout', { sid });
    assert.deepEqual([after.status, after.cookie], [204, 'K'], sub + ': a later, correctly bound logout of the absent session is confirmed again, without a row');
    assert.deepEqual(summary(rowsOf(await w.rows(), sub)), [['auth.logout', 'logout', A]], sub);
  }
  // (d) Bearer: no session, no row.
  const bearer = await w.issue('bearer', { sub: 'syn-sub-bearer', groups: [A] });
  out = await w.call(w.I1, 'logout', { bearer: bearer.access });
  assert.deepEqual([out.status, out.cookie], [204, 'K']);
  assert.deepEqual(rowsOf(await w.rows(), 'syn-sub-bearer'), []);
  // (e) U5S-REQ-05: a logout is independent of the token refresh and of the idle judgement. An expired stored access
  // token with Keycloak refusing every refresh, and a session idle for 13 h: each is ended by the logout itself - its own
  // cause, no /token request, nothing left to the guard.
  kc.auto = () => reply.reject();
  const tokensBefore = kc.tokens;
  out = await w.call(w.I1, 'logout', { sid: await w.session(await w.issue('e1', { sub: 'syn-sub-e1', groups: [A] }), { atExpiresAt: lapsed() }) });
  kc.auto = null;
  assert.deepEqual([out.status, out.cookie, kc.tokens - tokensBefore], [204, 'K', 0]);
  out = await w.call(w.I1, 'logout', { sid: await w.session(await w.issue('e2', { sub: 'syn-sub-e2', groups: [B] }), { lastSeenAt: past(13 * HOUR) }) });
  assert.deepEqual([out.status, out.cookie], [204, 'K']);
  assert.deepEqual(summary([...rowsOf(await w.rows(), 'syn-sub-e1'), ...rowsOf(await w.rows(), 'syn-sub-e2')]),
    [['auth.logout', 'logout', A], ['auth.logout', 'logout', B]]);
  assert.equal(w.I1.handled + w.I2.handled, 0);
  await w.finish('AS-04');
});

test('AS-05 a login start that ends the browser session records the cause it declared: logout, account_switch or reauthentication (A019)', async t => {
  const w = await world(t);
  // [kind, body, account, session options, the row's cause, its trigger, the prompt of the final step]
  for (const [kind, body, sub, options, cause, trigger, prompt] of [
    ['switch', SWITCH, 'syn-sub-s1', {}, 'account_switch', undefined, 'login'],
    ['signup', undefined, 'syn-sub-s2', {}, 'reauthentication', 'register', 'create'],
    ['switch', SWITCH, 'syn-sub-s3', { lastSeenAt: past(13 * HOUR) }, 'account_switch', undefined, 'login'],
    ['switch', UNFINISHED, 'syn-sub-s4', {}, 'logout', undefined, 'login'],
    ['switch', UNTRUSTED, 'syn-sub-s5', {}, 'reauthentication', 'storage_untrusted', 'login'],
    ['switch', UNREADABLE, 'syn-sub-s6', {}, 'reauthentication', 'record_unreadable', 'login']]) {
    const sid = await w.session(await w.issue(sub, { sub, groups: [B] }), options);
    const out = await w.call(w.I1, kind, { sid, body });
    assert.deepEqual([out.status, out.cookie, atProvider(out)], [200, 'P', true], sub);
    // The provider session was ended and its end confirmed before the address is given: the final step asks for
    // credentials on a form with an editable name (prompt=login), or opens the registration.
    assert.deepEqual([promptOf(out), kc.ended.includes('syn-idp-' + sub), await w.marks().then(m => m.find(x => x[0] === 'syn-idp-' + sub))],
      [prompt, true, ['syn-idp-' + sub, cause, true]], sub);
    assert.equal(await w.version(sid), null, sub);
    const rows = rowsOf(await w.rows(), sub);
    assert.deepEqual(summary(rows), [['auth.logout', cause, B]], sub + ': one row, the declared cause, never an expiry - also when idle');
    assert.equal(rows[0].detail.trigger, trigger, sub);
  }
  const before = (await w.rows()).length;
  // A link (GET) carries no intent whatever its address says, and ends nothing; a start for a session that is already
  // gone writes no row either.
  for (const sid of [undefined, 'syn-unknown-sid-' + randomUUID()]) {
    const out = await w.call(w.I1, 'login', { sid, query: { prompt: 'login', intent: 'reauthenticate', reason: 'switch_account' } });
    assert.deepEqual([out.status, !!out.pending, promptOf(out)], [302, true, null]);
    const gone = await w.call(w.I1, 'switch', { sid, body: SWITCH, binding: null });
    assert.deepEqual([gone.status, gone.cookie, promptOf(gone)], [200, 'P', 'none'], 'nothing to end: the SSO is probed first');
    const signup = await w.call(w.I1, 'signup', { sid, binding: null });
    assert.deepEqual([signup.status, signup.cookie, promptOf(signup)], [200, 'P', 'create']);
  }
  assert.equal((await w.rows()).length, before, 'no cookie or an absent session: no row');
  // A start without a declared reason, or with one the server does not know, starts nothing and ends nothing.
  const kept = await w.session(await w.issue('syn-sub-s7', { sub: 'syn-sub-s7', groups: [B] }));
  for (const body of [undefined, {}, { prompt: 'login' }, { intent: 'reauthenticate' }, { intent: 'reauthenticate', reason: 'register' },
    { intent: 'other', reason: 'switch_account' }]) {
    const out = await w.call(w.I1, 'switch', { sid: kept, body });
    assert.deepEqual([...coded(out), out.cookie, out.pending, await w.version(kept)],
      [400, 'AUTH_LOGIN_INTENT_INVALID', 'AUTH_LOGIN_INTENT_INVALID', 'K', null, 'syn-sub-s7'], JSON.stringify(body ?? null));
  }
  await w.finish('AS-05');
});

test('AS-06 idle: one row at the end, none at exactly twelve hours or before', async t => {
  const w = await world(t);
  const sid = await w.session(await w.issue('i1', { sub: 'syn-sub-i1', groups: [A] }), { lastSeenAt: past(IDLE + 1000) });
  let out = await w.call(w.I1, 'get', { sid });
  assert.deepEqual([out.status, out.body?.message, out.cookie], [401, EXPIRED, 'K']);
  assert.deepEqual(rowsOf(await w.rows(), 'syn-sub-i1').map(r => r.detail), [{ institution: A, ip: IP, dataSubject: null, cause: 'idle' }]);
  // Two requests of one idle session overlap (RT-12): one row.
  const sid2 = await w.session(await w.issue('i2', { sub: 'syn-sub-i2', groups: [B] }), { lastSeenAt: past(IDLE + 1000) });
  const gate = w.gate('I1', 'tx.open');
  const held = w.call(w.I1, 'get', { sid: sid2 });
  await gate.arrived();
  const won = await w.call(w.I2, 'get', { sid: sid2 });
  gate.release();
  const lost = await held;
  assert.deepEqual([won.status, won.cookie, lost.status, lost.body?.message, lost.cookie], [401, 'K', 401, EXPIRED, 'K']);
  assert.deepEqual(summary(rowsOf(await w.rows(), 'syn-sub-i2')), [['auth.session.expired', 'idle', B]]);
  // Exactly twelve hours is the cutoff itself and not idle; 11 h 59 min neither.
  for (const [sub, age] of [['syn-sub-i3', IDLE], ['syn-sub-i4', IDLE - 60_000]]) {
    out = await w.call(w.I1, 'get', { sid: await w.session(await w.issue(sub, { sub, groups: [A] }), { lastSeenAt: past(age) }) });
    assert.deepEqual([out.status, out.cookie], [200, 'K'], sub);
    assert.deepEqual(rowsOf(await w.rows(), sub), [], sub);
  }
  out = await w.call(w.I1, 'get', { sid: 'syn-unknown-' + randomUUID() });
  assert.deepEqual([out.status, out.body?.message, out.cookie], [401, ABSENT, 'K']);
  assert.equal((await w.rows()).length, 2);
  await w.finish('AS-06');
});

test('AS-07 refresh: a refusal ends the session once, a success adds no row and is not refreshed again', async t => {
  const w = await world(t);
  // Keycloak's own refusal of the refresh token (400 invalid_grant) ends the session. An answer that is not that refusal
  // ends nothing: U5S-AMD-04 below.
  kc.auto = () => reply.reject();
  let out = await w.call(w.I1, 'get', { sid: await w.session(await w.issue('syn-sub-r1', { sub: 'syn-sub-r1', groups: [A] }), { atExpiresAt: lapsed() }) });
  kc.auto = null;
  assert.deepEqual([out.status, out.body?.code, out.body?.message, out.authCode, out.cookie], [401, 'AUTH_SESSION_ENDED', REFUSED, 'AUTH_SESSION_ENDED', 'K']);
  assert.deepEqual(summary(rowsOf(await w.rows(), 'syn-sub-r1')), [['auth.session.expired', 'refresh_failed', A]]);
  // Two requests of one instance on the same snapshot share one /token request.
  kc.held = [];
  let tokens = kc.tokens;
  const sid4 = await w.session(await w.issue('r4', { sub: 'syn-sub-r4', groups: [B] }), { atExpiresAt: lapsed() });
  const both = [w.call(w.I1, 'get', { sid: sid4 }), w.call(w.I1, 'get', { sid: sid4 })];
  (await heldToken(1, 'the shared refresh')).answer(reply.reject());
  const shared = await Promise.all(both);
  assert.deepEqual([shared.map(o => [o.status, o.cookie]), kc.tokens - tokens], [[[401, 'K'], [401, 'K']], 1]);
  assert.deepEqual(summary(rowsOf(await w.rows(), 'syn-sub-r4')), [['auth.session.expired', 'refresh_failed', B]]);
  // Two instances, both refused (RT-04): one row, two 401s.
  kc.held = [];
  const sid5 = await w.session(await w.issue('r5', { sub: 'syn-sub-r5', groups: [A] }), { atExpiresAt: lapsed() });
  const r1 = w.call(w.I1, 'get', { sid: sid5 });
  const k1 = await heldToken(1);
  const r2 = w.call(w.I2, 'get', { sid: sid5 });
  const k2 = await heldToken(2);
  k1.answer(reply.reject());
  k2.answer(reply.reject());
  const pair = await Promise.all([r1, r2]);
  assert.deepEqual(pair.map(o => [o.status, o.cookie]), [[401, 'K'], [401, 'K']]);
  assert.deepEqual(summary(rowsOf(await w.rows(), 'syn-sub-r5')), [['auth.session.expired', 'refresh_failed', A]]);
  // A success is stored once and adopted: no row, one /token although its stored atExpiresAt is already past.
  const next = await w.issue('r6-next', { sub: 'syn-sub-r6', groups: [A], expIn: 20 });
  kc.auto = () => reply.tokens(next);
  tokens = kc.tokens;
  const sid6 = await w.session(await w.issue('r6', { sub: 'syn-sub-r6', groups: [A] }), { atExpiresAt: lapsed() });
  out = await w.call(w.I1, 'get', { sid: sid6 });
  // (the stored token of that answer is itself inside its lead: the same request adopts it and starts no second refresh)
  kc.auto = null;
  assert.deepEqual([out.status, out.cookie, await w.version(sid6), kc.tokens - tokens], [200, 'K', 'r6-next', 1]);
  assert.deepEqual(rowsOf(await w.rows(), 'syn-sub-r6'), []);
  await w.finish('AS-07');
});

// ── AS-08: the sweep, through the product's own lifecycle hook and its real hourly timer ──

test('AS-08 (a) the hourly sweep ends every idle session with one sweep row; (c) 13 h idle never reaches Keycloak; (d) an idle request first leaves the sweep nothing', async t => {
  const w = await world(t);
  w.I2.service.onModuleInit();
  try {
    for (const [sub, inst] of [['syn-sub-w1', A], ['syn-sub-w2', B], ['syn-sub-w3', Z]])
      await w.session(await w.issue(sub, { sub, groups: [inst] }), { lastSeenAt: past(13 * HOUR) });
    // At the first run (one hour on) this one is exactly twelve hours old: the cutoff itself, not idle.
    const recent = await w.session(await w.issue('w4', { sub: 'syn-sub-w4', groups: [A] }), { lastSeenAt: past(11 * HOUR) });
    w.tick(HOUR);
    // Wait on the outcome (the three idle sessions gone), not on how the sweep deletes them: a sweep that deletes
    // without rows must reach the row assertion below.
    await w.until('the first sweep run', async () => (await w.sessions()) === 1);
    assert.deepEqual([await w.sessions(), await w.version(recent)], [1, 'w4']);
    const rows = await w.rows();
    assert.deepEqual(summary(rows), [['auth.session.expired', 'sweep', A], ['auth.session.expired', 'sweep', B],
      ['auth.session.expired', 'sweep', Z]]);
    assert.deepEqual(rows.map(r => r.detail.ip), [null, null, null], 'a sweep has no request address');
    assert.deepEqual(rows.map(r => r.target).sort(), ['syn-sub-w1', 'syn-sub-w2', 'syn-sub-w3']);
    // The boundary session would be a target of the next run; it is taken away so that (d) has one target.
    await w.base.authSession.deleteMany({ where: { sid: recent } });
    // (c) the control: a 13 h idle session with an expired token ends idle in the guard, before any refresh.
    const tokens = kc.tokens;
    const out = await w.call(w.I1, 'get', { sid: await w.session(await w.issue('w5', { sub: 'syn-sub-w5', groups: [B] }),
      { lastSeenAt: past(13 * HOUR), atExpiresAt: lapsed() }) });
    assert.deepEqual([out.status, out.body?.message, out.cookie, kc.tokens - tokens], [401, EXPIRED, 'K', 0]);
    assert.deepEqual(summary(rowsOf(await w.rows(), 'syn-sub-w5')), [['auth.session.expired', 'idle', B]]);
    // (d) the sweep has read a target and waits before its delete; the target's own request ends it idle first.
    // Every end so far is confirmed first (each confirmation is a short transaction of its own, and an unconfirmed mark
    // would be retried by I2's cycle in a transaction of its own): the gate below is then the sweep's.
    await w.told();
    await w.until('every end so far confirmed', async () => (await w.marks()).every(mark => mark[2]));
    const sid6 = await w.session(await w.issue('w6', { sub: 'syn-sub-w6', groups: [A] }), { lastSeenAt: past(13 * HOUR) });
    const gate = w.gate('I2', 'tx.open');
    w.tick(HOUR);
    await gate.arrived();
    const idle = await w.call(w.I1, 'get', { sid: sid6 });
    assert.deepEqual([idle.status, idle.body?.message], [401, EXPIRED]);
    const ended = w.calls.filter(c => c === 'I2:tx:end').length;
    gate.release();
    await w.until('the held sweep delete', async () => w.calls.filter(c => c === 'I2:tx:end').length === ended + 1);
    assert.deepEqual(summary(rowsOf(await w.rows(), 'syn-sub-w6')), [['auth.session.expired', 'idle', A]]);
  } finally {
    w.I2.service.onModuleDestroy();
  }
  await w.finish('AS-08');
});

// ── AS-09: the DB failure boundary ──

/** A synthetic database error: distinct markers in its message, name, code, meta, cause and stack (no real data). */
function dbError(tag) {
  const error = new Error('SYN-MARK-MSG-' + tag);
  error.name = 'SYN-MARK-NAME-' + tag;
  error.code = 'SYN-MARK-CODE-' + tag;
  error.meta = { modelName: 'SYN-MARK-META-' + tag };
  error.cause = new Error('SYN-MARK-CAUSE-' + tag);
  error.stack = 'SYN-MARK-STACK-' + tag + '\n    at synthetic (synthetic.js:1:1)';
  return error;
}
const markers = tag => ['MSG', 'NAME', 'CODE', 'META', 'CAUSE', 'STACK'].map(kind => ['marker-' + kind.toLowerCase(), `SYN-MARK-${kind}-${tag}`]);
const storageFailure = out => out.status === 500 && out.body?.code === 'AUTH_STORAGE_FAILURE'
  && typeof out.body?.message === 'string' && Object.keys(out.body).sort().join() === 'code,message';

test('AS-09 a DB failure on any path is a fixed 500 with nothing committed and no cookie change; once fixed, exactly one transition commits', async t => {
  const w = await world(t);
  let n = 0;
  const sub = () => 'syn-sub-f' + (++n);
  // (1) login: the session and its success row roll back together; the failure row is tried apart.
  for (const point of ['tx.create', 'tx.audit']) {
    const s = sub();
    w.fault('I1', point, dbError('login-' + point));
    const done = (await login(w, w.I1, await w.issue(s, { sub: s, groups: [A] }))).done;
    assert.deepEqual([done.status, done.location, done.newSid], [302, ORIGIN + '/worklist/hpacs-lite/index.html?auth_error=login_failed', null], point);
    assert.deepEqual(summary(rowsOf(await w.rows(), s)), [['auth.login', 'session_failed', A]], point);
    assert.equal(rowsOf(await w.rows(), s)[0].detail.outcome, 'failure', point);
    assert.equal(await w.sessions(), 0, point);
    const again = (await login(w, w.I1, await w.issue(s + '-again', { sub: s, groups: [A] }))).done;
    assert.equal(again.status, 302);
    assert.deepEqual(summary(rowsOf(await w.rows(), s)), [['auth.login', 'session_failed', A], ['auth.login', 'success', A]], point);
    await w.base.authSession.deleteMany({});
  }
  // (2) logout (U5S-REQ-05, S06): 500, the session kept, no row, no cookie change and no Keycloak call - the session is
  // revoked before Keycloak is told, so a failed revocation tells it nothing. Retried: 204, one logout row, one call.
  for (const point of ['tx.delete', 'tx.audit']) {
    const s = sub(), v = await w.issue(s, { sub: s, groups: [B] }), sid = await w.session(v), logouts = kc.logouts;
    w.fault('I1', point, dbError('logout-' + point));
    const out = await w.call(w.I1, 'logout', { sid });
    assert.ok(storageFailure(out), point);
    assert.deepEqual([out.cookie, await w.version(sid), kc.logouts - logouts], ['K', s, 0], point);
    assert.deepEqual(rowsOf(await w.rows(), s), [], point);
    const retry = await w.call(w.I1, 'logout', { sid });
    assert.deepEqual([retry.status, retry.cookie, await w.told() - logouts], [204, 'K', 1], point);
    assert.deepEqual(summary(rowsOf(await w.rows(), s)), [['auth.logout', 'logout', B]], point);
  }
  // ... and when the stored access token has meanwhile expired and Keycloak refuses every refresh, the retried logout
  // still ends the session itself: a logout row, no /token request (the logout does not refresh the session it ends).
  {
    const s = sub(), sid = await w.session(await w.issue(s, { sub: s, groups: [A], expIn: 60 }));
    w.fault('I1', 'tx.delete', dbError('logout-kc'));
    assert.ok(storageFailure(await w.call(w.I1, 'logout', { sid })));
    w.tick(45_000);
    kc.auto = () => reply.reject();
    const tokens = kc.tokens;
    const retry = await w.call(w.I1, 'logout', { sid });
    kc.auto = null;
    assert.deepEqual([retry.status, retry.cookie, kc.tokens - tokens], [204, 'K', 0]);
    assert.deepEqual(summary(rowsOf(await w.rows(), s)), [['auth.logout', 'logout', A]]);
  }
  // (3) account switch and registration: 500, no pending cookie, no Keycloak address, the session kept; then 200 and one row.
  for (const [kind, body, point] of [['switch', SWITCH, 'tx.delete'], ['signup', undefined, 'tx.audit']]) {
    const s = sub(), sid = await w.session(await w.issue(s, { sub: s, groups: [B] }));
    w.fault('I2', point, dbError('switch-' + point));
    const out = await w.call(w.I2, kind, { sid, body });
    assert.ok(storageFailure(out), kind);
    assert.deepEqual([out.cookie, out.pending, out.location, await w.version(sid)], ['K', null, null, s], kind);
    assert.deepEqual([rowsOf(await w.rows(), s), await w.mark('syn-idp-' + s), kc.endRequests.includes('syn-idp-' + s)], [[], null, false], kind);
    const retry = await w.call(w.I2, kind, { sid, body });
    assert.deepEqual([retry.status, retry.cookie, await w.version(sid)], [200, 'P', null], kind);
    assert.deepEqual(summary(rowsOf(await w.rows(), s)), [['auth.logout', kind === 'switch' ? 'account_switch' : 'reauthentication', B]], kind);
    // The retry that ended the session left the one end mark, with its cause, and the provider confirmed the end.
    assert.deepEqual((await w.marks()).filter(m => m[0] === 'syn-idp-' + s), [['syn-idp-' + s, kind === 'switch' ? 'account_switch' : 'reauthentication', true]], kind);
  }
  // (4) idle: 500 before the handler, no cookie change; then 401 and one idle row.
  for (const point of ['tx.delete', 'tx.audit']) {
    const s = sub(), sid = await w.session(await w.issue(s, { sub: s, groups: [A] }), { lastSeenAt: past(13 * HOUR) });
    w.fault('I1', point, dbError('idle-' + point));
    const handled = w.I1.handled;
    const out = await w.call(w.I1, 'get', { sid });
    assert.ok(storageFailure(out), point);
    assert.deepEqual([out.cookie, w.I1.handled - handled, await w.version(sid)], ['K', 0, s], point);
    const retry = await w.call(w.I1, 'get', { sid });
    assert.deepEqual([retry.status, retry.body?.message, retry.cookie], [401, EXPIRED, 'K'], point);
    assert.deepEqual(summary(rowsOf(await w.rows(), s)), [['auth.session.expired', 'idle', A]], point);
  }
  // (5) a refused refresh whose end fails: 500 (not 401), the session as it was; retried with Keycloak still refusing:
  // 401 and exactly one refresh_failed row; retried with Keycloak answering: authenticated, a new version, no row.
  for (const [point, retryAnswer] of [['tx.delete', 'reject'], ['tx.audit', 'tokens']]) {
    const s = sub(), sid = await w.session(await w.issue(s, { sub: s, groups: [B] }), { atExpiresAt: lapsed() });
    const next = await w.issue(s + '-next', { sub: s, groups: [B] });
    kc.auto = () => reply.reject();
    w.fault('I1', point, dbError('refused-' + point));
    const handled = w.I1.handled;
    const out = await w.call(w.I1, 'get', { sid });
    assert.ok(storageFailure(out), point);
    assert.deepEqual([out.cookie, w.I1.handled - handled, await w.version(sid)], ['K', 0, s], point);
    assert.deepEqual(rowsOf(await w.rows(), s), [], point);
    kc.auto = () => retryAnswer === 'reject' ? reply.reject() : reply.tokens(next);
    const retry = await w.call(w.I1, 'get', { sid });
    kc.auto = null;
    if (retryAnswer === 'reject') {
      assert.deepEqual([retry.status, retry.body?.message, retry.cookie, await w.version(sid)], [401, REFUSED, 'K', null], point);
      assert.deepEqual(summary(rowsOf(await w.rows(), s)), [['auth.session.expired', 'refresh_failed', B]], point);
    } else {
      assert.deepEqual([retry.status, retry.cookie, await w.version(sid)], [200, 'K', s + '-next'], point);
      assert.deepEqual(rowsOf(await w.rows(), s), [], point);
    }
  }
  // (6) storing a successful refresh fails: 500, not refresh_failed, the old version kept; the next request decides anew.
  for (const nextAnswer of ['reject', 'accept']) {
    const s = sub(), sid = await w.session(await w.issue(s, { sub: s, groups: [A] }), { atExpiresAt: lapsed() });
    const next = await w.issue(s + '-next', { sub: s, groups: [A] }), later = await w.issue(s + '-later', { sub: s, groups: [A] });
    kc.auto = () => reply.tokens(next);
    w.fault('I1', 'tx.updateMany', dbError('store-' + nextAnswer));
    const out = await w.call(w.I1, 'get', { sid });
    assert.ok(storageFailure(out), nextAnswer);
    assert.deepEqual([out.cookie, await w.version(sid)], ['K', s], nextAnswer);
    kc.auto = () => nextAnswer === 'reject' ? reply.reject() : reply.tokens(later);
    const retry = await w.call(w.I1, 'get', { sid });
    kc.auto = null;
    if (nextAnswer === 'reject') {
      assert.deepEqual([retry.status, retry.body?.message, retry.cookie], [401, REFUSED, 'K']);
      assert.deepEqual(summary(rowsOf(await w.rows(), s)), [['auth.session.expired', 'refresh_failed', A]]);
    } else {
      assert.deepEqual([retry.status, await w.version(sid)], [200, s + '-later']);
      assert.deepEqual(rowsOf(await w.rows(), s), []);
    }
  }
  // (7) the sweep: one target's end fails and rolls back alone; the others end; the next run ends it.
  w.I2.service.onModuleInit();
  try {
    const before = (await w.rows()).length;
    const subs = [];
    for (const inst of [A, B, Z]) { const s = sub(); subs.push(s); await w.session(await w.issue(s, { sub: s, groups: [inst] }), { lastSeenAt: past(13 * HOUR) }); }
    w.fault('I2', 'tx.delete', dbError('sweep'));
    // The sweep's three end attempts (its conditional deletes; the provider end's confirmation opens transactions of its own).
    const deletes = w.calls.filter(c => c === 'I2:tx.delete').length;
    w.tick(HOUR);
    const left = async () => w.base.authSession.count({ where: { sub: { in: subs } } });
    await w.until('the sweep run with one failure', async () => w.calls.filter(c => c === 'I2:tx.delete').length === deletes + 3
      && (await w.rows()).length === before + 2);
    assert.equal(await left(), 1);
    assert.ok(capture.texts.some(([, text]) => /auth_storage category=sweep_target/.test(text)), 'a fixed category is logged');
    w.tick(HOUR);
    await w.until('the next sweep run', async () => (await w.rows()).length === before + 3);
    assert.equal(await left(), 0);
    assert.deepEqual(summary((await w.rows()).filter(r => subs.includes(r.target))),
      [['auth.session.expired', 'sweep', A], ['auth.session.expired', 'sweep', B], ['auth.session.expired', 'sweep', Z]]);
  } finally {
    w.I2.service.onModuleDestroy();
  }
  assert.equal(w.faults.length, 0, 'every injected failure was reached');
  await w.finish('AS-09', { output: ['login-tx.create', 'login-tx.audit', 'logout-tx.delete', 'logout-tx.audit', 'logout-kc',
    'switch-tx.delete', 'switch-tx.audit', 'idle-tx.delete', 'idle-tx.audit', 'refused-tx.delete', 'refused-tx.audit',
    'store-reject', 'store-accept', 'sweep'].flatMap(markers) });
});

// ── AS-10: fields, secrets and the output boundary ──

test('AS-10 (a) the address is the proxy\'s X-Real-IP only; every row has its exact keys and no secret (checked at every world end)', async t => {
  const w = await world(t);
  const cases = [['syn-sub-p1', { ip: IP, headers: { 'x-forwarded-for': '203.0.113.8, ' + IP } }, IP],
    ['syn-sub-p2', { ip: 'not-an-ip' }, null], ['syn-sub-p3', { ip: '2001:db8::7' }, '2001:db8::7'], ['syn-sub-p4', { ip: null }, null]];
  for (const [s, request, expected] of cases) {
    const out = await w.call(w.I1, 'logout', { sid: await w.session(await w.issue(s, { sub: s, groups: [A] })), ...request });
    assert.equal(out.status, 204, s);
    assert.deepEqual(rowsOf(await w.rows(), s).map(r => r.detail.ip), [expected], s);
  }
  await w.finish('AS-10a');
});

test('AS-10 (b) synthetic DB error markers never reach a response, the logger, stdout/stderr or a timer rejection', async t => {
  const w = await world(t);
  const rejections = [];
  const onRejection = reason => rejections.push(String(reason?.stack ?? reason));
  process.on('unhandledRejection', onRejection);
  const scenarios = [];
  const run = async (tag, body) => {
    const from = capture.texts.length, answers = w.responses.length;
    await body(tag);
    scenarios.push({ tag, output: capture.texts.slice(from).map(([, text]) => text), responses: w.responses.slice(answers).flat() });
  };
  try {
    const session = async (tag, options = {}) => w.session(await w.issue(tag, { sub: 'syn-sub-' + tag, groups: [A] }), options);
    await run('guard-read', async tag => { const sid = await session(tag); w.fault('I1', 'read', dbError(tag)); assert.ok(storageFailure(await w.call(w.I1, 'get', { sid }))); });
    await run('logout-delete', async tag => { const sid = await session(tag); w.fault('I1', 'tx.delete', dbError(tag)); assert.ok(storageFailure(await w.call(w.I1, 'logout', { sid }))); });
    await run('logout-audit', async tag => { const sid = await session(tag); w.fault('I1', 'tx.audit', dbError(tag)); assert.ok(storageFailure(await w.call(w.I1, 'logout', { sid }))); });
    await run('switch-read', async tag => { const sid = await session(tag); w.fault('I1', 'read', dbError(tag)); assert.ok(storageFailure(await w.call(w.I1, 'switch', { sid, body: SWITCH }))); });
    await run('switch-audit', async tag => { const sid = await session(tag); w.fault('I1', 'tx.audit', dbError(tag)); assert.ok(storageFailure(await w.call(w.I1, 'signup', { sid }))); });
    await run('idle-delete', async tag => { const sid = await session(tag, { lastSeenAt: past(13 * HOUR) }); w.fault('I1', 'tx.delete', dbError(tag)); assert.ok(storageFailure(await w.call(w.I1, 'get', { sid }))); });
    await run('refused-audit', async tag => {
      const sid = await session(tag, { atExpiresAt: lapsed() });
      kc.auto = () => reply.reject();
      w.fault('I1', 'tx.audit', dbError(tag));
      const out = await w.call(w.I1, 'get', { sid });
      kc.auto = null;
      assert.ok(storageFailure(out));
    });
    await run('store', async tag => {
      const sid = await session(tag, { atExpiresAt: lapsed() }), next = await w.issue(tag + '-next', { sub: 'syn-sub-' + tag, groups: [A] });
      kc.auto = () => reply.tokens(next);
      w.fault('I1', 'tx.updateMany', dbError(tag));
      const out = await w.call(w.I1, 'get', { sid });
      kc.auto = null;
      assert.ok(storageFailure(out));
    });
    await run('touch', async tag => { const sid = await session(tag, { lastSeenAt: past(10 * 60_000) }); w.fault('I1', 'touch', dbError(tag)); assert.ok(storageFailure(await w.call(w.I1, 'get', { sid }))); });
    await run('login-both', async tag => {
      w.fault('I1', 'tx.create', dbError(tag));
      w.fault('I1', 'audit', dbError(tag + '-row'));
      const done = (await login(w, w.I1, await w.issue(tag, { sub: 'syn-sub-' + tag, groups: [A] }))).done;
      assert.equal(done.location, ORIGIN + '/worklist/hpacs-lite/index.html?auth_error=login_failed');
    });
    await run('callback-read', async tag => { const sid = await session(tag); w.fault('I1', 'read', dbError(tag)); const out = await w.call(w.I1, 'callback', { sid, query: {} }); assert.deepEqual([out.status, out.location], [302, landing('login_failed')], 'a callback is a top-level navigation: it is sent to the landing, never answered with an error body'); });
    w.I2.service.onModuleInit();
    try {
      await run('sweep-read', async tag => {
        await session(tag, { lastSeenAt: past(13 * HOUR) });
        w.fault('I2', 'sweepRead', dbError(tag));
        w.tick(HOUR);
        await w.until('the failed sweep read', async () => !w.faults.length);
        await new Promise(resolve => setTimeout(resolve, 100));
      });
      await run('sweep-target', async tag => {
        const targets = await w.base.authSession.count({ where: { lastSeenAt: { lt: new Date(Date.now() + HOUR - IDLE) } } });
        // One conditional delete per target (the provider end's confirmation opens transactions of its own).
        const deletes = w.calls.filter(c => c === 'I2:tx.delete').length;
        w.fault('I2', 'tx.delete', dbError(tag));
        w.tick(HOUR);
        await w.until('the sweep over every target', async () => !w.faults.length
          && w.calls.filter(c => c === 'I2:tx.delete').length === deletes + targets);
        await new Promise(resolve => setTimeout(resolve, 100));
      });
    } finally {
      w.I2.service.onModuleDestroy();
    }
    assert.equal(w.faults.length, 0, 'every injected failure was reached');
    for (const scenario of scenarios) {
      const secrets = [...markers(scenario.tag), ...markers(scenario.tag + '-row')];
      const found = { responses: secretHits(scenario.responses, secrets), output: secretHits(scenario.output, secrets) };
      report(JSON.stringify({ case: 'AS-10b', scenario: scenario.tag, ...found }));
      assert.deepEqual(found, { responses: [], output: [] }, scenario.tag);
    }
    assert.deepEqual(secretHits(rejections, scenarios.flatMap(s => markers(s.tag))), [], 'timer rejections');
    // Negative control: the same Nest path handed the raw synthetic error prints its markers - the collector sees them.
    const host = (req = { headers: {} }) => new ExecutionContextHost([req, { req, sent: false }]);
    let from = capture.texts.length;
    w.exceptions.next(dbError('negative'), host());
    const negative = secretHits(capture.texts.slice(from).map(([, text]) => text), markers('negative'));
    assert.ok(negative.includes('marker-msg') && negative.includes('marker-stack'), 'the raw error reaches the logger: ' + negative.join());
    // Positive control: the service's fixed answer passes the same path with nothing to find.
    from = capture.texts.length;
    w.exceptions.next(new InternalServerErrorException({ code: 'AUTH_STORAGE_FAILURE', message: 'SYN fixed' }), host());
    assert.deepEqual(secretHits(capture.texts.slice(from).map(([, text]) => text), markers('negative')), []);
    report(JSON.stringify({ case: 'AS-10b', control: 'negative', found: negative }));
  } finally {
    process.off('unhandledRejection', onRejection);
  }
  await w.finish('AS-10b');
});

// ── AS-12: the outcome table RT-01..RT-15, one timeline each (scenario-table section 0.A) ──
// Each timeline holds Keycloak's /token answers (heldToken) and/or an instance before its next AuthSession write
// (w.gate), asserts the state at the hold where the contract names one, and ends with the remaining session (its version
// label), each request's public result, the exact set of end rows (action, cause, institution) and the cookie letters
// (K kin_sid untouched, P untouched with a new pending login, S a new kin_sid; E - an expired kin_sid - is what no
// answer gives any more, U5S-REQ-10). Rows are counted per account (target), login rows apart.

const chainAnswers = map => form => map.has(form.refresh_token) ? reply.tokens(map.get(form.refresh_token)) : reply.reject();
const endsOf = async (w, sub) => summary(rowsOf(await w.rows(), sub).filter(r => r.action !== 'auth.login'));

test('AS-12 T1 (RT-01, X-11) and its sequential attribution variants (X-18)', async t => {
  const w = await world(t);
  const s = 'syn-sub-t1';
  const v1 = await w.issue('t1-v1', { sub: s, groups: [A] }), v2 = await w.issue('t1-v2', { sub: s, groups: [B] });
  const sid = await w.session(v1, { atExpiresAt: lapsed(), lastSeenAt: past(10 * 60_000) });
  const r1 = w.call(w.I1, 'get', { sid });
  const k1 = await heldToken(1, 'I1 refresh');
  const r2 = w.call(w.I2, 'get', { sid });
  const k2 = await heldToken(2, 'I2 refresh');
  k2.answer(reply.tokens(v2));
  const o2 = await r2;
  assert.deepEqual([o2.status, await w.version(sid)], [200, 't1-v2'], 'I2 stored and touched v2');
  k1.answer(reply.reject());
  const o1 = await r1;
  assert.deepEqual([o1.status, o1.cookie, o2.cookie, await w.version(sid), await endsOf(w, s)], [200, 'K', 'K', 't1-v2', []]);
  // X-18: after a completed refresh v1 (A) -> v2 (B), every way of ending the session records B.
  const chain = new Map();
  kc.auto = chainAnswers(chain);
  w.I2.service.onModuleInit();
  try {
    for (const [end, row] of [['switch', ['auth.logout', 'account_switch', B]], ['logout', ['auth.logout', 'logout', B]],
      ['idle', ['auth.session.expired', 'idle', B]], ['sweep', ['auth.session.expired', 'sweep', B]]]) {
      const sub = 'syn-sub-t1-' + end;
      const a = await w.issue(sub + '-a', { sub, groups: [A] }), b = await w.issue(sub + '-b', { sub, groups: [B] });
      chain.set(a.refresh, b);
      const sidX = await w.session(a, { atExpiresAt: lapsed() });
      assert.deepEqual([(await w.call(w.I1, 'get', { sid: sidX })).status, await w.version(sidX)], [200, sub + '-b']);
      if (end === 'switch') await w.call(w.I1, 'switch', { sid: sidX, body: SWITCH });
      else if (end === 'logout') await w.call(w.I1, 'logout', { sid: sidX });
      else {
        await w.base.authSession.update({ where: { sid: sidX }, data: { lastSeenAt: past(13 * HOUR) } });
        if (end === 'idle') await w.call(w.I1, 'get', { sid: sidX });
        else { w.tick(HOUR); await w.until('the sweep', async () => (await w.version(sidX)) === null); }
      }
      assert.deepEqual(await endsOf(w, sub), [row], end);
    }
  } finally {
    w.I2.service.onModuleDestroy();
    kc.auto = null;
  }
  await w.finish('AS-12 T1');
});

test('AS-12 T1b (RT-02, X-28): two successes cross; the later one is discarded, in both arrival orders', async t => {
  const w = await world(t);
  for (const order of ['I2 first', 'I1 first']) {
    kc.held = [];
    const s = 'syn-sub-t1b-' + order.split(' ')[0];
    const v1 = await w.issue(s + '-v1', { sub: s, groups: [A] }), v2 = await w.issue(s + '-v2', { sub: s, groups: [B] });
    const v2p = await w.issue(s + '-v2p', { sub: s, groups: [A] });
    const sid = await w.session(v1, { atExpiresAt: lapsed() });
    const r1 = w.call(w.I1, 'get', { sid });
    const k1 = await heldToken(1);
    const r2 = w.call(w.I2, 'get', { sid });
    const k2 = await heldToken(2);
    let o1, o2;
    if (order === 'I2 first') { k2.answer(reply.tokens(v2)); o2 = await r2; k1.answer(reply.tokens(v2p)); o1 = await r1; }
    else { k1.answer(reply.tokens(v2p)); o1 = await r1; k2.answer(reply.tokens(v2)); o2 = await r2; }
    assert.deepEqual([o1.status, o2.status, o1.cookie, o2.cookie, await w.version(sid), await endsOf(w, s)],
      [200, 200, 'K', 'K', order === 'I2 first' ? s + '-v2' : s + '-v2p', []], order);
  }
  await w.finish('AS-12 T1b');
});

test('AS-12 T2 (RT-03, X-12): a refusal ends v1 first; a late success or refusal adds nothing and revives nothing', async t => {
  const w = await world(t);
  for (const late of ['success', 'refusal']) {
    kc.held = [];
    const s = 'syn-sub-t2-' + late;
    const v1 = await w.issue(s + '-v1', { sub: s, groups: [A] }), v2 = await w.issue(s + '-v2', { sub: s, groups: [B] });
    const sid = await w.session(v1, { atExpiresAt: lapsed() });
    const r1 = w.call(w.I1, 'get', { sid });
    const k1 = await heldToken(1);
    const r2 = w.call(w.I2, 'get', { sid });
    const k2 = await heldToken(2);
    k1.answer(reply.reject());
    const o1 = await r1;
    assert.deepEqual([o1.status, o1.body?.message, o1.cookie], [401, REFUSED, 'K'], late);
    k2.answer(late === 'success' ? reply.tokens(v2) : reply.reject());
    const o2 = await r2;
    assert.deepEqual([o2.status, o2.body?.message, o2.cookie, await w.version(sid), await endsOf(w, s)],
      [401, REFUSED, 'K', null, [['auth.session.expired', 'refresh_failed', A]]], late);
  }
  await w.finish('AS-12 T2');
});

test('AS-12 T3 (RT-05, X-13; logout order per U5S-REQ-05): a logout ends v1 while v1\'s refresh is held, without refreshing it; the late answer revives nothing', async t => {
  const w = await world(t);
  for (const late of ['success', 'refusal']) {
    kc.held = [];
    kc.auto = null;
    const s = 'syn-sub-t3-' + late;
    const v1 = await w.issue(s + '-v1', { sub: s, groups: [A] }), v2 = await w.issue(s + '-v2', { sub: s, groups: [B] });
    const v2p = await w.issue(s + '-v2p', { sub: s, groups: [A] });
    const sid = await w.session(v1, { atExpiresAt: lapsed() });
    const r1 = w.call(w.I1, 'get', { sid });
    const k1 = await heldToken(1, 'R1 refresh');
    // Keycloak would answer a refresh of v1 with v2 (B); the logout must not ask: it ends the version it read (A).
    kc.auto = chainAnswers(new Map([[v1.refresh, v2]]));
    const asked = kc.tokens;
    const out = await w.call(w.I2, 'logout', { sid });
    kc.auto = null;
    assert.deepEqual([out.status, out.cookie, kc.tokens - asked, await endsOf(w, s)], [204, 'K', 0, [['auth.logout', 'logout', A]]], late);
    k1.answer(late === 'success' ? reply.tokens(v2p) : reply.reject());
    const o1 = await r1;
    assert.deepEqual([o1.status, o1.body?.message, o1.cookie, await w.version(sid), await endsOf(w, s)],
      [401, REFUSED, 'K', null, [['auth.logout', 'logout', A]]], late);
  }
  await w.finish('AS-12 T3');
});

test('AS-12 T4 (RT-05, X-14): an account switch or registration ends v1 while its refresh is held', async t => {
  const w = await world(t);
  for (const [kind, body, late] of [['switch', SWITCH, 'success'], ['switch', SWITCH, 'refusal'],
    ['signup', undefined, 'success'], ['signup', undefined, 'refusal']]) {
    kc.held = [];
    const s = `syn-sub-t4-${kind}-${late}`;
    const v1 = await w.issue(s + '-v1', { sub: s, groups: [A] }), v2 = await w.issue(s + '-v2', { sub: s, groups: [B] });
    const sid = await w.session(v1, { atExpiresAt: lapsed() });
    const r1 = w.call(w.I1, 'get', { sid });
    const k1 = await heldToken(1);
    const out = await w.call(w.I2, kind, { sid, body });
    const cause = kind === 'switch' ? 'account_switch' : 'reauthentication';
    assert.deepEqual([out.status, out.cookie, await endsOf(w, s)], [200, 'P', [['auth.logout', cause, A]]], s);
    k1.answer(late === 'success' ? reply.tokens(v2) : reply.reject());
    const o1 = await r1;
    assert.deepEqual([o1.status, o1.cookie, await w.version(sid), await endsOf(w, s)],
      [401, 'K', null, [['auth.logout', cause, A]]], s);
  }
  await w.finish('AS-12 T4');
});

test('AS-12 T5 (RT-07, X-15/X-16): the sweep or another request ends v1 idle while its refresh is held', async t => {
  const w = await world(t);
  // idle variants (X-16): R1 passes the idle check just before the cutoff; R2, after it, ends the session idle.
  for (const late of ['success', 'refusal']) {
    kc.held = [];
    const s = 'syn-sub-t5i-' + late;
    const v1 = await w.issue(s + '-v1', { sub: s, groups: [A] }), v2 = await w.issue(s + '-v2', { sub: s, groups: [B] });
    const sid = await w.session(v1, { lastSeenAt: new Date(Date.now() - IDLE + 10_000), atExpiresAt: lapsed() });
    const r1 = w.call(w.I1, 'get', { sid });
    const k1 = await heldToken(1);
    w.tick(30_000);
    const o2 = await w.call(w.I2, 'get', { sid, ip: '198.51.100.9' });
    assert.deepEqual([o2.status, o2.body?.message, o2.cookie], [401, EXPIRED, 'K'], late);
    k1.answer(late === 'success' ? reply.tokens(v2) : reply.reject());
    const o1 = await r1;
    assert.deepEqual([o1.status, o1.body?.message, o1.cookie, await w.version(sid), await endsOf(w, s)],
      [401, REFUSED, 'K', null, [['auth.session.expired', 'idle', A]]], late);
    assert.deepEqual(rowsOf(await w.rows(), s).map(r => r.detail.ip), ['198.51.100.9'], 'the address of the request that ended it');
  }
  // sweep variants (X-15): the timer runs while R1's refresh is held.
  w.I2.service.onModuleInit();
  let due = Date.now() + HOUR;
  try {
    for (const late of ['success', 'refusal']) {
      kc.held = [];
      w.tick(due - 30_000 - Date.now());
      const s = 'syn-sub-t5s-' + late;
      const v1 = await w.issue(s + '-v1', { sub: s, groups: [A] }), v2 = await w.issue(s + '-v2', { sub: s, groups: [B] });
      const sid = await w.session(v1, { lastSeenAt: new Date(Date.now() - IDLE + 10_000), atExpiresAt: lapsed() });
      const r1 = w.call(w.I1, 'get', { sid });
      const k1 = await heldToken(1);
      w.tick(30_000);
      await w.until('the sweep', async () => (await w.version(sid)) === null);
      k1.answer(late === 'success' ? reply.tokens(v2) : reply.reject());
      const o1 = await r1;
      assert.deepEqual([o1.status, o1.cookie, await endsOf(w, s)], [401, 'K', [['auth.session.expired', 'sweep', A]]], late);
      assert.deepEqual(rowsOf(await w.rows(), s).map(r => r.detail.ip), [null]);
      due += HOUR;
    }
  } finally {
    w.I2.service.onModuleDestroy();
  }
  await w.finish('AS-12 T5');
});

for (const fixture of ['different-exp', 'same-exp']) {
  test(`AS-08 (b) = AS-12 T6 (RT-08, X-17) ${fixture}: the sweep read v1, R stored v2 and waits before its touch; the sweep deletes nothing`, async t => {
    const w = await world(t);
    w.I2.service.onModuleInit();
    const T = Date.now() + HOUR;          // the timer's next expiry
    try {
      w.tick(HOUR - 1000);                // R starts at T - 1 s
      const s = 'syn-sub-t6';
      const v1 = await w.issue('t6-v1', { sub: s, groups: [A], expIn: fixture === 'same-exp' ? 2 : HOUR / 1000 });
      const v2 = await w.issue('t6-v2', { sub: s, groups: [B], same: fixture === 'same-exp' ? v1 : undefined, expIn: 2 * HOUR / 1000 });
      // lastSeenAt = R's start - 12 h + 0.5 s: R passes the idle check; stored atExpiresAt is past, so R refreshes.
      const atExpiresAt = fixture === 'same-exp' ? new Date(v1.exp * 1000 - LEAD) : lapsed();
      const sid = await w.session(v1, { lastSeenAt: new Date(Date.now() - IDLE + 500), atExpiresAt });
      const sweep = w.gate('I2', 'tx.open');
      const r = w.call(w.I1, 'get', { sid });
      const k = await heldToken(1, 'R refresh');
      w.tick(1500);                       // T + 0.5 s: the idle boundary and the timer expiry both pass
      await sweep.arrived();              // the sweep read v1 and waits before its delete
      const touch = w.gate('I1', 'touch');
      k.answer(reply.tokens(v2));
      await touch.arrived();              // v2 is stored (committed); R waits before its touch
      assert.deepEqual([await w.version(sid), (await w.lastSeen(sid)) < T - IDLE], ['t6-v2', true],
        'at the hold: the session is v2 and still idle for the sweep\'s cutoff');
      if (fixture === 'same-exp')
        assert.equal((await w.base.authSession.findUnique({ where: { sid } })).atExpiresAt.getTime(), atExpiresAt.getTime(), 'same stored atExpiresAt');
      const ended = w.calls.filter(c => c === 'I2:tx:end').length;
      sweep.release();
      await w.until('the sweep delete', async () => w.calls.filter(c => c === 'I2:tx:end').length === ended + 1);
      assert.deepEqual([await w.version(sid), await endsOf(w, s)], ['t6-v2', []], 'the sweep skipped the contested session');
      touch.release();
      const out = await r;
      assert.deepEqual([out.status, out.cookie, (await w.lastSeen(sid)) >= T], [200, 'K', true]);
    } finally {
      w.I2.service.onModuleDestroy();
    }
    await w.finish('AS-12 T6 ' + fixture);
  });
}

test('AS-12 T7 (RT-13, RT-14, RT-02; X-21, X-22): same-exp tokens of different versions', async t => {
  const w = await world(t);
  const flow = async (name, steps) => {
    kc.held = [];
    const s = 'syn-sub-t7' + name;
    const exp = { exp: Math.floor(Date.now() / 1000) + 2 };
    const v = {};
    for (const [label, group] of [['v1', A], ['v2', B], ['v2p', A], ['v3', B]]) v[label] = await w.issue(`${s}-${label}`, { sub: s, groups: [group], same: exp });
    const sid = await w.session(v.v1);
    const r1 = w.call(w.I1, 'get', { sid });
    const k1 = await heldToken(1);
    const r2 = w.call(w.I2, 'get', { sid });
    const k2 = await heldToken(2);
    return steps({ s, v, sid, r1, k1, r2, k2 });
  };
  // (a) v2 stored, v1's refusal: I1 refreshes v2 anew; at that hold the session is v2 with no row. Then success or refusal.
  for (const then of ['success', 'refusal']) {
    await flow('a-' + then, async ({ s, v, sid, r1, k1, r2, k2 }) => {
      k2.answer(reply.tokens(v.v2));
      assert.equal((await r2).status, 200);
      k1.answer(reply.reject());
      const k1b = await heldToken(3, 'I1\'s refresh of v2');
      assert.ok(k1b.form.refresh_token === v.v2.refresh, 'the follow-up refresh uses v2');
      assert.deepEqual([await w.version(sid), await endsOf(w, s)], [s + '-v2', []], 'at the hold');
      k1b.answer(then === 'success' ? reply.tokens(v.v3) : reply.reject());
      const o1 = await r1;
      if (then === 'success') assert.deepEqual([o1.status, await w.version(sid), await endsOf(w, s)], [200, s + '-v3', []]);
      else assert.deepEqual([o1.status, o1.cookie, await w.version(sid), await endsOf(w, s)],
        [401, 'K', null, [['auth.session.expired', 'refresh_failed', B]]]);
    });
  }
  // (b) v2 stored, then v1's late success v2' is discarded; the follow-up refresh of v2 is held with v2 in place.
  await flow('b', async ({ s, v, sid, r1, k1, r2, k2 }) => {
    k2.answer(reply.tokens(v.v2));
    await r2;
    k1.answer(reply.tokens(v.v2p));
    const k1b = await heldToken(3);
    assert.deepEqual([await w.version(sid), await endsOf(w, s)], [s + '-v2', []], 'at the hold: v2, not v2\'');
    k1b.answer(reply.tokens(v.v3));
    assert.deepEqual([(await r1).status, await w.version(sid)], [200, s + '-v3']);
  });
  // (c) the refusal first: v1 ends (A); the late success revives nothing.
  await flow('c', async ({ s, v, sid, r1, k1, r2, k2 }) => {
    k1.answer(reply.reject());
    assert.equal((await r1).status, 401);
    k2.answer(reply.tokens(v.v2));
    assert.deepEqual([(await r2).status, await w.version(sid), await endsOf(w, s)],
      [401, null, [['auth.session.expired', 'refresh_failed', A]]]);
  });
  // (d) RT-14: Keycloak gives I2 v1's own two values - not a new version; v1's refusal then ends v1 (A).
  await flow('d', async ({ s, v, sid, r1, k1, r2, k2 }) => {
    k2.answer(reply.tokens(v.v1));
    const o2 = await r2;
    k1.answer(reply.reject());
    const o1 = await r1;
    assert.deepEqual([o2.status, o2.cookie, o1.status, o1.cookie, await w.version(sid), await endsOf(w, s)],
      [200, 'K', 401, 'K', null, [['auth.session.expired', 'refresh_failed', A]]]);
  });
  await w.finish('AS-12 T7');
});

test('AS-12 T8 (RT-06, X-23): an account switch read v1; v2 (B) is stored before its delete; it ends v2 and records B', async t => {
  const w = await world(t);
  for (const [kind, body] of [['switch', SWITCH], ['signup', undefined]]) {
    const s = 'syn-sub-t8-' + kind;
    const v1 = await w.issue(s + '-v1', { sub: s, groups: [A] }), v2 = await w.issue(s + '-v2', { sub: s, groups: [B] });
    const sid = await w.session(v1, { atExpiresAt: lapsed() });
    const gate = w.gate('I1', 'tx.open');
    const sw = w.call(w.I1, kind, { sid, body });
    await gate.arrived();
    kc.auto = chainAnswers(new Map([[v1.refresh, v2]]));
    const o2 = await w.call(w.I2, 'get', { sid });
    kc.auto = null;
    assert.deepEqual([o2.status, o2.cookie, await w.version(sid)], [200, 'K', s + '-v2'], kind);
    gate.release();
    const out = await sw;
    assert.deepEqual([out.status, out.cookie, await w.version(sid), await endsOf(w, s)],
      [200, 'P', null, [['auth.logout', kind === 'switch' ? 'account_switch' : 'reauthentication', B]]], kind);
  }
  await w.finish('AS-12 T8');
});

/** I1 runs an end request; between each of its reads and deletes I2 refreshes the session (rounds), then `last` runs. */
async function interleavedEnds(w, { s, kind, body, rounds, groups = [B], last }) {
  const versions = [];
  for (let n = 0; n <= rounds + 2; n++) versions.push(await w.issue(`${s}-v${n}`, { sub: s, groups: n ? groups : [A], expIn: 2 }));
  const chain = new Map(versions.slice(0, -1).map((v, n) => [v.refresh, versions[n + 1]]));
  kc.auto = chainAnswers(chain);
  const sid = await w.session(versions[0]);
  let gate = w.gate('I1', 'tx.open');
  const held = w.call(w.I1, kind, { sid, body });
  for (let n = 1; n <= rounds; n++) {
    await gate.arrived();
    const current = gate;
    if (n < rounds) gate = w.gate('I1', 'tx.open');
    if (n === rounds && last) await last(sid);
    else assert.equal((await w.call(w.I2, 'get', { sid })).status, 200, 'I2\'s refresh in round ' + n);
    current.release();
  }
  const out = await held;
  kc.auto = null;
  return { out, sid, versions };
}

test('AS-12 T9 (RT-15, X-24, O-10, X-33): three interleaved refreshes give an end request 409; the next request ends it', async t => {
  const w = await world(t);
  // account switch: 409, no cookie change, no pending, no redirect, the competitor's last version kept, no row.
  let s = 'syn-sub-t9-switch';
  let { out, sid } = await interleavedEnds(w, { s, kind: 'switch', body: SWITCH, rounds: 3 });
  assert.deepEqual([out.status, out.cookie, out.pending, out.location, await endsOf(w, s)], [409, 'K', null, null, []]);
  const kept = await w.version(sid);
  assert.ok(kept && kept.startsWith(s + '-v'), 'a later version remains');
  out = await w.call(w.I1, 'switch', { sid, body: SWITCH });
  assert.deepEqual([out.status, out.cookie, await w.version(sid), await endsOf(w, s)], [200, 'P', null, [['auth.logout', 'account_switch', B]]]);
  // logout (the competitor's refreshes keep winning its three deletes): 409 AUTH_SESSION_BUSY - not ended, Keycloak not
  // told (S06) - then the next logout ends the kept version as it stands, without a refresh of its own.
  s = 'syn-sub-t9-logout';
  let logouts = kc.logouts;
  ({ out, sid } = await interleavedEnds(w, { s, kind: 'logout', rounds: 3 }));
  assert.deepEqual([out.status, out.body?.code, out.authCode, out.cookie, kc.logouts - logouts, await endsOf(w, s)],
    [409, 'AUTH_SESSION_BUSY', 'AUTH_SESSION_BUSY', 'K', 0, []]);
  assert.ok(await w.version(sid), 'the session is still there after the bounded conflict');
  const asked = kc.tokens;
  out = await w.call(w.I1, 'logout', { sid });
  assert.deepEqual([out.status, out.cookie, kc.tokens - asked, await w.told() - logouts, await w.version(sid), await endsOf(w, s)],
    [204, 'K', 0, 1, null, [['auth.logout', 'logout', B]]]);
  // X-33: after the third conflict the session is already gone (I2 logged out): the end completes, 409 is not given,
  // and the row is the one of the transition that deleted it.
  for (const kind of ['switch', 'logout']) {
    s = 'syn-sub-t9-absent-' + kind;
    ({ out, sid } = await interleavedEnds(w, { s, kind, body: kind === 'switch' ? SWITCH : undefined, rounds: 3,
      last: async sidX => assert.equal((await w.call(w.I2, 'logout', { sid: sidX })).status, 204) }));
    assert.deepEqual([out.status, out.cookie, await w.version(sid), await endsOf(w, s)],
      [kind === 'switch' ? 200 : 204, kind === 'switch' ? 'P' : 'K', null, [['auth.logout', 'logout', B]]], kind);
  }
  await w.finish('AS-12 T9');
});

test('AS-12 T10 (RT-06, X-25): a logout read v1 (A); v2 (B) is stored before its delete; it ends v2 and records B', async t => {
  const w = await world(t);
  const s = 'syn-sub-t10';
  const v1 = await w.issue(s + '-v1', { sub: s, groups: [A], expIn: 2 });
  const v2 = await w.issue(s + '-v2', { sub: s, groups: [B], expIn: 2 });
  kc.auto = chainAnswers(new Map([[v1.refresh, v2]]));
  const sid = await w.session(v1);
  const gate = w.gate('I1', 'tx.open');
  const held = w.call(w.I1, 'logout', { sid });
  await gate.arrived();
  assert.equal(await w.version(sid), s + '-v1', 'the logout read v1 and did not refresh it');
  assert.equal((await w.call(w.I2, 'get', { sid })).status, 200);
  assert.equal(await w.version(sid), s + '-v2');
  gate.release();
  const out = await held;
  kc.auto = null;
  assert.deepEqual([out.status, out.cookie, await w.version(sid), await endsOf(w, s)], [204, 'K', null, [['auth.logout', 'logout', B]]]);
  await w.finish('AS-12 T10');
});

test('AS-12 T11 (RT-15, X-26, X-33): a request whose every refresh write loses three times gets 409; the next succeeds', async t => {
  const w = await world(t);
  const run = async (s, last) => {
    kc.held = [];
    const versions = [], mine = [];
    for (let n = 0; n <= 4; n++) versions.push(await w.issue(`${s}-v${n}`, { sub: s, groups: [B], expIn: 2 }));
    for (let n = 0; n <= 4; n++) mine.push(await w.issue(`${s}-mine${n}`, { sub: s, groups: [B], expIn: 2 }));
    // Per refresh token: the first request (I1, which asks first) gets I1's answer, the second (I2) the competitor's.
    const asked = new Map();
    kc.auto = form => {
      const n = versions.findIndex(v => v.refresh === form.refresh_token);
      if (n < 0) return reply.reject();
      const times = (asked.get(n) ?? 0) + 1;
      asked.set(n, times);
      return reply.tokens(times === 1 ? mine[n] : versions[n + 1]);
    };
    const sid = await w.session(versions[0]);
    const tokens = kc.tokens, handled = w.I1.handled;
    let gate = w.gate('I1', 'tx.open');
    const held = w.call(w.I1, 'get', { sid });
    for (let n = 1; n <= 3; n++) {
      await gate.arrived();
      const current = gate;
      if (n < 3) gate = w.gate('I1', 'tx.open');
      if (n === 3 && last) await last(sid);
      else assert.equal((await w.call(w.I2, 'get', { sid })).status, 200, 'I2 stores first in round ' + n);
      current.release();
    }
    const out = await held;
    return { out, sid, versions, tokens: kc.tokens - tokens, handled: w.I1.handled - handled };
  };
  let s = 'syn-sub-t11';
  const { out, sid, tokens, handled } = await run(s);
  assert.deepEqual([out.status, out.cookie, handled, await w.version(sid), await endsOf(w, s), tokens],
    [409, 'K', 0, s + '-v3', [], 6], 'three lost writes: 409, the competitor\'s v3 kept, no fourth /token from I1');
  const next = await w.call(w.I1, 'get', { sid });
  kc.auto = null;
  assert.deepEqual([next.status, await w.version(sid)], [200, s + '-mine3'], 'the next request starts a new limit');
  // X-33: after the third lost write the session is gone (I2 logged out): 401, not 409.
  s = 'syn-sub-t11-absent';
  const absent = await run(s, async sidX => assert.equal((await w.call(w.I2, 'logout', { sid: sidX })).status, 204));
  kc.auto = null;
  assert.deepEqual([absent.out.status, absent.out.body?.message, absent.out.cookie, await w.version(absent.sid), await endsOf(w, s)],
    [401, REFUSED, 'K', null, [['auth.logout', 'logout', B]]]);
  await w.finish('AS-12 T11');
});

test('AS-12 T12 (RT-09, X-29): R2 judged v1 idle and waits; R stored v2 (B) - (a) touched: R2 proceeds; (b) not yet: R2 ends v2, idle B', async t => {
  const w = await world(t);
  for (const variant of ['a', 'b']) {
    kc.held = [];
    const s = 'syn-sub-t12' + variant;
    const v1 = await w.issue(s + '-v1', { sub: s, groups: [A] }), v2 = await w.issue(s + '-v2', { sub: s, groups: [B] });
    const sid = await w.session(v1, { lastSeenAt: new Date(Date.now() - IDLE + 500), atExpiresAt: lapsed() });
    const r = w.call(w.I1, 'get', { sid });
    const k = await heldToken(1, 'R refresh');
    w.tick(1000);
    const gate2 = w.gate('I2', 'tx.open');
    const r2 = w.call(w.I2, 'get', { sid, ip: '198.51.100.9' });
    await gate2.arrived();
    const cutoff2 = Date.now() - IDLE;
    if (variant === 'a') {
      k.answer(reply.tokens(v2));
      assert.equal((await r).status, 200);
      assert.deepEqual([await w.version(sid), (await w.lastSeen(sid)) >= cutoff2], [s + '-v2', true], '(a) at the hold: v2, fresh');
      gate2.release();
      const o2 = await r2;
      assert.deepEqual([o2.status, o2.cookie, await w.version(sid), await endsOf(w, s)], [200, 'K', s + '-v2', []], '(a)');
    } else {
      const touch = w.gate('I1', 'touch');
      k.answer(reply.tokens(v2));
      await touch.arrived();
      assert.deepEqual([await w.version(sid), (await w.lastSeen(sid)) < cutoff2], [s + '-v2', true], '(b) at the hold: v2 stored, still idle');
      gate2.release();
      const o2 = await r2;
      assert.deepEqual([o2.status, o2.body?.message, o2.cookie, await w.version(sid), await endsOf(w, s)],
        [401, EXPIRED, 'K', null, [['auth.session.expired', 'idle', B]]], '(b) exactly one idle row, institution B');
      touch.release();
      assert.deepEqual([(await r).status, (await r).cookie], [200, 'K'], '(b) R, already adopted, completes');
    }
  }
  await w.finish('AS-12 T12');
});

test('AS-12 T13 (RT-10, X-30): a touch makes v1 fresh before a held idle or sweep delete of the same version', async t => {
  const w = await world(t);
  // idle variant
  let s = 'syn-sub-t13i';
  let sid = await w.session(await w.issue(s + '-v1', { sub: s, groups: [A] }), { lastSeenAt: new Date(Date.now() - IDLE + 500) });
  let touch = w.gate('I1', 'touch');
  let r = w.call(w.I1, 'get', { sid });
  await touch.arrived();
  w.tick(1000);
  const gate2 = w.gate('I2', 'tx.open');
  const r2 = w.call(w.I2, 'get', { sid });
  await gate2.arrived();
  touch.release();
  assert.equal((await r).status, 200);
  gate2.release();
  const o2 = await r2;
  assert.deepEqual([o2.status, o2.cookie, await w.version(sid), await endsOf(w, s)], [200, 'K', s + '-v1', []]);
  // sweep variant
  w.I2.service.onModuleInit();
  try {
    w.tick(HOUR - 500);
    s = 'syn-sub-t13s';
    sid = await w.session(await w.issue(s + '-v1', { sub: s, groups: [A] }), { lastSeenAt: new Date(Date.now() - IDLE + 300) });
    touch = w.gate('I1', 'touch');
    r = w.call(w.I1, 'get', { sid });
    await touch.arrived();
    const sweep = w.gate('I2', 'tx.open');
    w.tick(1000);
    await sweep.arrived();
    touch.release();
    assert.equal((await r).status, 200);
    const ended = w.calls.filter(c => c === 'I2:tx:end').length;
    sweep.release();
    await w.until('the sweep delete', async () => w.calls.filter(c => c === 'I2:tx:end').length === ended + 1);
    assert.deepEqual([await w.version(sid), await endsOf(w, s)], [s + '-v1', []]);
  } finally {
    w.I2.service.onModuleDestroy();
  }
  await w.finish('AS-12 T13');
});

test('AS-12 T14 (RT-11, X-31): idle or sweep ends v1 before the touch of an adopted request; that request completes', async t => {
  const w = await world(t);
  let s = 'syn-sub-t14i';
  let sid = await w.session(await w.issue(s + '-v1', { sub: s, groups: [A] }), { lastSeenAt: new Date(Date.now() - IDLE + 500) });
  let touch = w.gate('I1', 'touch');
  let r = w.call(w.I1, 'get', { sid });
  await touch.arrived();
  w.tick(1000);
  assert.equal((await w.call(w.I2, 'get', { sid })).status, 401);
  touch.release();
  let o = await r;
  assert.deepEqual([o.status, o.cookie], [200, 'K'], 'the adopted request completes');
  o = await w.call(w.I1, 'get', { sid });
  assert.deepEqual([o.status, o.body?.message, o.cookie, await endsOf(w, s)], [401, ABSENT, 'K', [['auth.session.expired', 'idle', A]]]);
  w.I2.service.onModuleInit();
  try {
    w.tick(HOUR - 500);
    s = 'syn-sub-t14s';
    sid = await w.session(await w.issue(s + '-v1', { sub: s, groups: [B] }), { lastSeenAt: new Date(Date.now() - IDLE + 300) });
    touch = w.gate('I1', 'touch');
    r = w.call(w.I1, 'get', { sid });
    await touch.arrived();
    w.tick(1000);
    await w.until('the sweep', async () => (await w.version(sid)) === null);
    touch.release();
    o = await r;
    assert.deepEqual([o.status, o.cookie], [200, 'K']);
    o = await w.call(w.I1, 'get', { sid });
    assert.deepEqual([o.status, o.body?.message, o.cookie, await endsOf(w, s)], [401, ABSENT, 'K', [['auth.session.expired', 'sweep', B]]]);
  } finally {
    w.I2.service.onModuleDestroy();
  }
  await w.finish('AS-12 T14');
});

test('AS-12 T15 (RT-12, X-32): two end transitions overlap; the one that deleted writes the one row', async t => {
  const w = await world(t);
  // (b) logout against account switch, both orders.
  for (const [first, firstKind, secondKind, row] of [['I1', 'logout', 'switch', ['auth.logout', 'account_switch', A]],
    ['I1', 'switch', 'logout', ['auth.logout', 'logout', A]]]) {
    const s = `syn-sub-t15-${firstKind}-held`;
    const sid = await w.session(await w.issue(s + '-v1', { sub: s, groups: [A] }));
    const gate = w.gate(first, 'tx.open');
    const body = kind => kind === 'switch' ? SWITCH : undefined;
    const held = w.call(w.I1, firstKind, { sid, body: body(firstKind) });
    await gate.arrived();
    const won = await w.call(w.I2, secondKind, { sid, body: body(secondKind) });
    gate.release();
    const lost = await held;
    const done = kind => kind === 'switch' ? [200, 'P'] : [204, 'K'];
    assert.deepEqual([[won.status, won.cookie], [lost.status, lost.cookie], await endsOf(w, s)],
      [done(secondKind), done(firstKind), [row]], s);
  }
  // (c) a logout of a session that is already ended (correctly bound): confirmed again, and no second row.
  const s = 'syn-sub-t15c';
  const sid = await w.session(await w.issue(s + '-v1', { sub: s, groups: [A] }));
  assert.equal((await w.call(w.I2, 'logout', { sid })).status, 204);
  const late = await w.call(w.I1, 'logout', { sid });
  assert.deepEqual([late.status, late.cookie, await endsOf(w, s)], [204, 'K', [['auth.logout', 'logout', A]]]);
  // (a) a logout past its guard waits before its delete; the sweep ends the session first; the logout completes on the
  // absence and adds no row.
  w.I2.service.onModuleInit();
  try {
    const s2 = 'syn-sub-t15a';
    const sid2 = await w.session(await w.issue(s2 + '-v1', { sub: s2, groups: [A], expIn: 24 * 3600 }));
    const gate = w.gate('I1', 'tx.open');
    const held = w.call(w.I1, 'logout', { sid: sid2 });
    await gate.arrived();
    w.tick(13 * HOUR);
    await w.until('the sweep', async () => (await w.version(sid2)) === null);
    gate.release();
    const out = await held;
    assert.deepEqual([out.status, out.cookie, await endsOf(w, s2)], [204, 'K', [['auth.session.expired', 'sweep', A]]]);
  } finally {
    w.I2.service.onModuleDestroy();
  }
  await w.finish('AS-12 T15');
});

// ── U5S session contract (Astra spec U5S-REQ-05, 08, 09, 10, 12 and the 2026-10-04 amendments 1-5, 9) ──
// U5S-REQ-05/08/09/10/18 -> U5S-RISK-SESSION / -AUDIT / -WAIT / -SUCCESS -> U5S-TEST-S05, S06, S07 (server and cookie
// half), S11 (one termination record) and the cases below. S06 (a failed or conflicting revocation confirms nothing and
// tells Keycloak nothing) is AS-09 (2), (3) and AS-12 T9 above. Of S12 this file holds the API half (what the DICOM
// subrequest `GET authz/dicom` answers: 401 or 403 with its code); that nginx forwards X-KIN-Session and relays the code
// header on the protected response is configuration read by a real proxy, which no case of this file starts.

/** [status, body code, X-KIN-Auth-Code] of an answer. */
const coded = out => [out.status, out.body?.code ?? null, out.authCode];

test('U5S-AMD-04 Keycloak unreachable, slow, failing or unreadable never ends a session; only its refusal of the refresh token does', async t => {
  const w = await world(t);
  // (a) The stored token has really expired, so the request waits for the refresh. Every answer that is not Keycloak's
  // refusal of the refresh token means "not now": 503 AUTH_IDP_UNAVAILABLE, the handler not reached, the session and its
  // version kept, no record, no cookie change. With Keycloak back the next request goes on with a new version.
  const forged = await w.issue('amd4-forged', { sub: 'syn-sub-amd4-unverifiable', groups: [A], key: 'other' });
  for (const [kind, answer] of [['drop', reply.drop], ['failing', reply.failing], ['unreadable', reply.unreadable],
    ['misconfigured', reply.misconfigured], ['unverifiable', () => reply.tokens(forged)], ['hang', reply.hang]]) {
    const s = 'syn-sub-amd4-' + kind;
    const sid = await w.session(await w.issue(s, { sub: s, groups: [A] }), { atExpiresAt: lapsed() });
    const next = await w.issue(s + '-next', { sub: s, groups: [A] });
    kc.auto = answer;
    const handled = w.I1.handled;
    const out = await w.call(w.I1, 'get', { sid });
    assert.deepEqual([...coded(out), out.cookie, w.I1.handled - handled, await w.version(sid), await endsOf(w, s)],
      [503, 'AUTH_IDP_UNAVAILABLE', 'AUTH_IDP_UNAVAILABLE', 'K', 0, s, []], kind);
    kc.auto = () => reply.tokens(next);
    const again = await w.call(w.I1, 'get', { sid });
    kc.auto = null;
    assert.deepEqual([again.status, again.cookie, await w.version(sid), await endsOf(w, s)], [200, 'K', s + '-next', []], kind + ': Keycloak back');
  }
  // (b) Inside the lead (the refresh is due, the token still valid): the request is answered without waiting for
  // Keycloak, and so is the next one, which shares the refresh that is out. What the refresh then brings is applied to
  // the session, never to those answers: a new version, nothing, or - on Keycloak's refusal - the end of the session.
  for (const kind of ['tokens', 'drop', 'reject']) {
    kc.held = [];
    const s = 'syn-sub-amd4-lead-' + kind;
    const v1 = await w.issue(s, { sub: s, groups: [B], expIn: 20 });
    const v2 = await w.issue(s + '-next', { sub: s, groups: [B] });
    const sid = await w.session(v1);
    const handled = w.I1.handled;
    const out = await w.call(w.I1, 'get', { sid });
    const k = await heldToken(1, 'the refresh ahead of the expiry');
    const second = await w.call(w.I1, 'get', { sid });
    assert.deepEqual([out.status, out.cookie, second.status, w.I1.handled - handled, kc.held.length, await w.version(sid)],
      [200, 'K', 200, 2, 1, s], kind + ': both answered while one refresh is out');
    assert.ok(k.form.refresh_token === v1.refresh, kind + ': the refresh is of the stored version');
    k.answer(kind === 'tokens' ? reply.tokens(v2) : kind === 'drop' ? reply.drop() : reply.reject());
    if (kind === 'tokens') {
      await w.until('the refreshed version', async () => (await w.version(sid)) === s + '-next');
      assert.deepEqual([(await w.call(w.I1, 'get', { sid })).status, kc.held.length, await endsOf(w, s)], [200, 1, []], kind);
    } else if (kind === 'drop') {
      // the failed refresh is over once a request starts another; the session is as it was
      await w.until('a new refresh after the failed one', async () => (await w.call(w.I1, 'get', { sid })).status === 200 && kc.held.length >= 2);
      assert.deepEqual([await w.version(sid), await endsOf(w, s)], [s, []], kind);
      kc.held[1].answer(reply.drop());
    } else {
      await w.until('the refused session ends', async () => (await w.version(sid)) === null);
      const after = await w.call(w.I1, 'get', { sid });
      assert.deepEqual([...coded(after), after.cookie, await endsOf(w, s)],
        [401, 'AUTH_SESSION_ENDED', 'AUTH_SESSION_ENDED', 'K', [['auth.session.expired', 'refresh_failed', B]]], kind);
    }
  }
  // (c) The key set cannot be fetched (a new process while Keycloak does not answer /certs): the stored token cannot be
  // verified now. That is 503, not a refusal; the session is kept and works once the keys can be fetched.
  for (const mode of ['drop', 'error']) {
    const s = 'syn-sub-amd4-jwks-' + mode;
    const sid = await w.session(await w.issue(s, { sub: s, groups: [A] }));
    const inst = w.instance('J-' + mode);
    kc.certs = mode;
    const out = await w.call(inst, 'get', { sid });
    kc.certs = 'ok';
    assert.deepEqual([...coded(out), out.cookie, inst.handled, await w.version(sid), await endsOf(w, s)],
      [503, 'AUTH_IDP_UNAVAILABLE', 'AUTH_IDP_UNAVAILABLE', 'K', 0, s, []], mode);
    const again = await w.call(inst, 'get', { sid });
    assert.deepEqual([again.status, again.cookie, inst.handled], [200, 'K', 1], mode + ': keys back');
  }
  // Control: a token that is itself wrong (signed by another key) is refused as a token - 401, not "Keycloak unavailable".
  const wrong = await w.call(w.I1, 'get', { bearer: forged.access });
  assert.deepEqual([wrong.status, wrong.body?.code ?? null], [401, null]);
  await w.finish('U5S-AMD-04');
});

test('U5S-TEST-S05 logout: the revocation and its record commit before Keycloak is told, the answer does not wait for Keycloak, and nothing revives the session', async t => {
  const w = await world(t);
  for (const mode of ['hang', 'drop', 'ok']) {
    const s = 'syn-sub-s05-' + mode;
    const sid = await w.session(await w.issue(s, { sub: s, groups: [A] }));
    kc.logoutMode = mode;
    // What the store holds at the moment Keycloak is told.
    const told = deferred();
    kc.onLogout = async () => { told.resolve({ session: await w.version(sid), rows: await endsOf(w, s) }); };
    const from = performance.now();
    const out = await w.call(w.I1, 'logout', { sid });
    // Keycloak never answers in 'hang': the logout's answer is here although that request has not been given up yet
    // (its bound is 2 s; an answer that waited for it would be later than that).
    const abandonedAtAnswer = kc.abandoned, took = performance.now() - from;
    assert.deepEqual([out.status, out.cookie, await w.version(sid), await endsOf(w, s)], [204, 'K', null, [['auth.logout', 'logout', A]]], mode);
    assert.deepEqual(await within(told.promise, 'Keycloak being told'), { session: null, rows: [['auth.logout', 'logout', A]] },
      mode + ': when Keycloak is told the session is already revoked and recorded');
    kc.onLogout = null;
    if (mode === 'hang') {
      assert.deepEqual([abandonedAtAnswer, took < 1500], [0, true], `the answer did not wait for the Keycloak request to end (${Math.round(took)} ms)`);
      // ... and nobody waits for that request, but it is not given up either (S7-U5 D600): past the 2 s the product waits,
      // the request is still open and its end unknown - the mark unconfirmed. Keycloak answers at last: that answer
      // settles it and confirms the end.
      await new Promise(resolve => setTimeout(resolve, 2500));
      assert.deepEqual([kc.abandoned, (await w.mark(idpOf(s))).confirmedAt, await w.changes(idpOf(s))], [0, null, ['unknown']],
        'the unanswered request is kept open; its end stays unknown');
      for (const release of kc.hung.splice(0)) release();
      await w.until('the late answer confirming the end', async () => (await w.mark(idpOf(s))).confirmedAt !== null);
      assert.deepEqual(await w.changes(idpOf(s)), ['done']);
    }
    // The ended session is refused by every process - one that never saw it included (nothing in memory could revive it).
    for (const inst of [w.I1, w.I2, w.instance('S05-' + mode)]) {
      const after = await w.call(inst, 'get', { sid });
      assert.deepEqual([...coded(after), after.cookie], [401, 'AUTH_SESSION_ENDED', 'AUTH_SESSION_ENDED', 'K'], mode);
    }
    // The same logout again (the answer was lost and the user asks again): confirmed, no second record.
    const again = await w.call(w.I2, 'logout', { sid });
    assert.deepEqual([again.status, again.cookie, await endsOf(w, s)], [204, 'K', [['auth.logout', 'logout', A]]], mode);
  }
  kc.logoutMode = 'ok';
  await w.finish('U5S-TEST-S05');
});

test('U5S-TEST-S07 a newer login S2: the held logout, the late 401 and every later request of the old document S1 leave S2\'s cookie, session and records untouched', async t => {
  const w = await world(t);
  const s = 'syn-sub-s07';
  // The browser's cookie jar: only what an answer sets changes it (the order of delivery is the order of these lines).
  let jar = null;
  const deliver = out => { if (out.expired) jar = null; if (out.newSid) jar = out.newSid; return out; };
  // S1: a login, entered by its document (which now holds S1's id).
  const one = await login(w, w.I1, await w.issue('s07-v1', { sub: s, groups: [A] }));
  deliver(one.done);
  const s1 = jar;
  const id1 = deliver(await w.call(w.I1, 'entry', { sid: jar, body: { proof: one.done.proof } })).body.sessionId;
  // Two requests of the S1 document are on their way and are held in the server: a read and its logout.
  const readGate = w.gate('I1', 'read');
  const heldRead = w.call(w.I1, 'get', { sid: s1, binding: id1 });
  await readGate.arrived();
  const logoutGate = w.gate('I1', 'tx.open');
  const heldLogout = w.call(w.I1, 'logout', { sid: s1, binding: id1 });
  await logoutGate.arrived();
  // Another tab logs in again (the same person): its document learnt S1's id at its bootstrap and starts a bound login,
  // which revokes S1 with its record; the callback then sets S2's cookie.
  const boot = deliver(await w.call(w.I2, 'me', { sid: jar }));
  assert.deepEqual([boot.status, boot.body.sessionId], [200, id1]);
  const begin = deliver(await w.call(w.I2, 'switch', { sid: jar, binding: boot.body.sessionId, body: SWITCH }));
  assert.deepEqual([begin.status, begin.cookie, jar], [200, 'P', s1], 'a login start sets a pending cookie and leaves kin_sid alone');
  // (the bound start ended S1's provider session; the new login is a new provider session)
  const v2 = await w.issue('s07-v2', { sub: s, groups: [A], idp: 'syn-idp-s07-second' });
  kc.auto = form => form.grant_type === 'authorization_code' ? reply.tokens(v2) : reply.reject();
  const state = new URL(begin.location).searchParams.get('state');
  w.secret('state', state);
  const done = deliver(await w.call(w.I2, 'callback', { sid: jar, cookie: begin.pendingCookie, query: { code: 'syn-code-' + randomUUID(), state } }));
  kc.auto = null;
  const s2 = jar;
  assert.deepEqual([done.status, done.cookie, s2 !== s1 && !!s2], [302, 'S', true]);
  const id2 = deliver(await w.call(w.I2, 'entry', { sid: jar, body: { proof: done.proof } })).body.sessionId;
  assert.notEqual(id2, id1);
  // Now the held S1 answers are released, after S2 exists: the read is a 401 of S1, the logout is confirmed (S1 is
  // gone) - and neither touches the cookie.
  readGate.release();
  const lateRead = deliver(await heldRead);
  logoutGate.release();
  const lateLogout = deliver(await heldLogout);
  assert.deepEqual([coded(lateRead), lateRead.cookie, lateLogout.status, lateLogout.cookie, jar],
    [[401, 'AUTH_SESSION_ENDED', 'AUTH_SESSION_ENDED'], 'K', 204, 'K', s2]);
  // Every later request of the S1 document rides the browser's cookie (S2) with S1's id: refused before any refresh,
  // handler, revocation or Keycloak call - and the refusal does not name S2.
  const logouts = await w.told();
  for (const [kind, options, status] of [['get', {}, 409], ['logout', {}, 409], ['switch', { body: SWITCH }, 409],
    ['signup', {}, 409], ['authz', {}, 403], ['me', {}, 409]]) {
    const calls = w.calls.length, tokens = kc.tokens, handled = w.I1.handled;
    const out = deliver(await w.call(w.I1, kind, { sid: jar, binding: id1, ...options }));
    assert.deepEqual([...coded(out), out.cookie, out.pending, w.calls.length - calls, kc.tokens - tokens, w.I1.handled - handled],
      [status, 'AUTH_SESSION_MISMATCH', 'AUTH_SESSION_MISMATCH', 'K', null, 0, 0, 0], kind);
    assert.deepEqual(secretHits([JSON.stringify(out.body)], [['s2-id', id2], ['s2-cookie', s2]]), [], kind + ': the refusal does not name the browser\'s session');
  }
  // ... and one without any id is told to bootstrap (428); a request refused is not a session ended.
  const unbound = deliver(await w.call(w.I1, 'get', { sid: jar, binding: null }));
  assert.deepEqual([...coded(unbound), unbound.cookie], [428, 'AUTH_SESSION_REQUIRED', 'AUTH_SESSION_REQUIRED', 'K']);
  // S2 is what it was: its cookie in the jar, an authenticated request, its identity, no Keycloak logout on its behalf.
  const mine = deliver(await w.call(w.I1, 'get', { sid: jar, binding: id2 }));
  const me = deliver(await w.call(w.I1, 'me', { sid: jar, binding: id2 }));
  assert.deepEqual([jar, mine.status, me.status, me.body.sub, me.body.sessionId, await w.version(s2), await w.told() - logouts],
    [s2, 200, 200, s, id2, 's07-v2', 0]);
  // The records: two logins, two entries, one termination of S1 (the bound login that revoked it) and none of S2.
  assert.deepEqual(summary(rowsOf(await w.rows(), s)), [['auth.entry', undefined, A], ['auth.entry', undefined, A],
    ['auth.login', 'success', A], ['auth.login', 'success', A], ['auth.logout', 'account_switch', A]]);
  await w.finish('U5S-TEST-S07');
});

test('U5S-TEST-S11 two documents of one session log out at once: both are confirmed, one termination record', async t => {
  const w = await world(t);
  for (const round of [1, 2, 3]) {
    const s = 'syn-sub-s11-' + round;
    const sid = await w.session(await w.issue(s, { sub: s, groups: [B] }));
    const answers = await Promise.all([w.call(w.I1, 'logout', { sid }), w.call(w.I2, 'logout', { sid }), w.call(w.I1, 'logout', { sid })]);
    assert.deepEqual([answers.map(o => [o.status, o.cookie]), await w.version(sid), await endsOf(w, s)],
      [[[204, 'K'], [204, 'K'], [204, 'K']], null, [['auth.logout', 'logout', B]]], 'round ' + round);
  }
  await w.finish('U5S-TEST-S11');
});

test('U5S-REQ-08 binding: no credentials 401, no binding 428, another session 409, an ended session 401 - before any read, refresh or handler; several documents of one session are ordinary; Bearer needs none', async t => {
  const w = await world(t);
  const s = 'syn-sub-b1';
  const live = await w.session(await w.issue(s, { sub: s, groups: [A] }));
  const other = await w.session(await w.issue('syn-sub-b2', { sub: 'syn-sub-b2', groups: [B] }));
  // Several documents (two tabs, a viewer window) of one session: each bootstraps once with an unbound `me`, gets the
  // same id - which is not the cookie - and works with it side by side, on any instance, the DICOM subrequest included.
  const d1 = await w.call(w.I1, 'me', { sid: live }), d2 = await w.call(w.I2, 'me', { sid: live }), d3 = await w.call(w.I2, 'me', { sid: other });
  assert.deepEqual([d1.status, d2.status, typeof d1.body.sessionId, d1.body.sessionId === d2.body.sessionId, d1.body.sessionId !== d3.body.sessionId],
    [200, 200, 'string', true, true]);
  assert.deepEqual(secretHits([d1.body.sessionId], [['cookie', live]]), [], 'the id is not the cookie value');
  const side = await Promise.all([w.call(w.I1, 'get', { sid: live, binding: d1.body.sessionId }), w.call(w.I2, 'get', { sid: live, binding: d2.body.sessionId }),
    w.call(w.I1, 'authz', { sid: live, binding: d2.body.sessionId }), w.call(w.I2, 'me', { sid: live, binding: d1.body.sessionId })]);
  assert.deepEqual(side.map(o => [o.status, o.cookie]), [[200, 'K'], [200, 'K'], [204, 'K'], [200, 'K']]);
  assert.deepEqual(await endsOf(w, s), []);
  // The refusals, on a session whose token has expired while Keycloak would refuse its refresh: asking Keycloak or
  // reading the session would end it, so "nothing read, nothing asked, no handler" is what keeps it alive.
  const lapsedSid = await w.session(await w.issue('syn-sub-b3', { sub: 'syn-sub-b3', groups: [A] }), { atExpiresAt: lapsed() });
  kc.auto = () => reply.reject();
  const refused = async (label, kind, options, expected, reads = 0) => {
    const calls = w.calls.length, tokens = kc.tokens, handled = w.I1.handled;
    const out = await w.call(w.I1, kind, options);
    assert.deepEqual([...coded(out), out.cookie, out.pending, w.calls.slice(calls), kc.tokens - tokens, w.I1.handled - handled],
      [...expected, 'K', null, Array(reads).fill('I1:read'), 0, 0], label);
    return out;
  };
  const otherId = d3.body.sessionId;
  await refused('no cookie and no token', 'get', {}, [401, 'AUTH_CREDENTIALS_MISSING', 'AUTH_CREDENTIALS_MISSING']);
  await refused('no cookie and no token, DICOM subrequest', 'authz', {}, [401, 'AUTH_CREDENTIALS_MISSING', 'AUTH_CREDENTIALS_MISSING']);
  for (const kind of ['get', 'logout', 'switch', 'signup']) {
    const body = kind === 'switch' ? SWITCH : undefined;
    // A login start without a binding looks whether there is a session to end at all (one read - it neither refreshes
    // nor ends anything): only then is the missing binding a refusal. A document that got 401 holds no id to send.
    await refused(kind + ' without a binding', kind, { sid: lapsedSid, binding: null, body }, [428, 'AUTH_SESSION_REQUIRED', 'AUTH_SESSION_REQUIRED'],
      ['switch', 'signup'].includes(kind) ? 1 : 0);
    await refused(kind + ' with another session\'s id', kind, { sid: lapsedSid, binding: otherId, body }, [409, 'AUTH_SESSION_MISMATCH', 'AUTH_SESSION_MISMATCH']);
  }
  await refused('a binding that is no id at all', 'get', { sid: lapsedSid, binding: 'x' }, [409, 'AUTH_SESSION_MISMATCH', 'AUTH_SESSION_MISMATCH']);
  // The DICOM subrequest answers the same two as 403 (the proxy passes 401 and 403 only); the code keeps them apart.
  await refused('DICOM subrequest without a binding', 'authz', { sid: lapsedSid, binding: null }, [403, 'AUTH_SESSION_REQUIRED', 'AUTH_SESSION_REQUIRED']);
  await refused('DICOM subrequest with another session\'s id', 'authz', { sid: lapsedSid, binding: otherId }, [403, 'AUTH_SESSION_MISMATCH', 'AUTH_SESSION_MISMATCH']);
  // A cookie request that changes something without the CSRF header: 403 with its own code.
  const csrf = await w.call(w.I1, 'logout', { sid: live, csrf: false });
  assert.deepEqual([...coded(csrf), csrf.cookie, await w.version(live)], [403, 'AUTH_CSRF_REQUIRED', 'AUTH_CSRF_REQUIRED', 'K', s]);
  kc.auto = null;
  assert.deepEqual([await w.version(lapsedSid), await endsOf(w, 'syn-sub-b3')], ['syn-sub-b3', []], 'none of the refusals read, refreshed or ended the session');
  // A link login (GET) revokes nothing: with a live session it goes back to the entrance, without a pending login.
  for (const kind of ['login', 'register']) {
    const link = await w.call(w.I1, kind, { sid: live });
    assert.deepEqual([link.status, link.location, link.cookie, await w.version(live)],
      [302, ORIGIN + '/worklist/hpacs-lite/index.html?auth_error=session_active', 'K', s], kind);
  }
  // A correctly bound request of a session that is gone: 401 AUTH_SESSION_ENDED, on the API and on the DICOM subrequest.
  const gone = 'syn-gone-' + randomUUID();
  for (const kind of ['get', 'authz', 'me']) {
    const out = await w.call(w.I1, kind, { sid: gone, binding: w.I1.service.sessionRef(gone) });
    assert.deepEqual([...coded(out), out.cookie], [401, 'AUTH_SESSION_ENDED', 'AUTH_SESSION_ENDED', 'K'], kind);
  }
  // Bearer: no binding, no CSRF header, and a cookie in the same request is not its session - a Bearer logout ends nothing.
  const bearer = await w.issue('b-bearer', { sub: 'syn-sub-b-bearer', groups: [A] });
  const viaToken = await w.call(w.I1, 'get', { bearer: bearer.access, sid: live, binding: 'syn-not-an-id' });
  const tokenMe = await w.call(w.I1, 'me', { bearer: bearer.access });
  const tokenLogout = await w.call(w.I1, 'logout', { bearer: bearer.access, sid: live, binding: null, csrf: false });
  assert.deepEqual([viaToken.status, tokenMe.body.sessionId, tokenMe.body.sub, tokenLogout.status, tokenLogout.cookie, await w.version(live), await endsOf(w, s)],
    [200, null, 'syn-sub-b-bearer', 204, 'K', s, []]);
  await w.finish('U5S-REQ-08');
});

test('U5S-REQ-09 entry proof: a login is entered once, by the document that holds its proof and its cookie; consumption and its record are one commit; a link or a second tab needs none', async t => {
  const w = await world(t);
  const s = 'syn-sub-e1';
  const first = await login(w, w.I1, await w.issue('e1', { sub: s, groups: [A], email: 'syn-e1@synthetic.test' }));
  const sid = first.done.newSid, proof = first.done.proof;
  const entries = async sub => rowsOf(await w.rows(), sub).filter(r => r.action === 'auth.entry');
  // Named refusals that consume nothing: a malformed body, no cookie, no CSRF header.
  for (const body of [{}, { proof: 7 }, { proof: '' }, { proof: 'x'.repeat(129) }, undefined])
    assert.deepEqual(coded(await w.call(w.I1, 'entry', { sid, body })), [400, 'AUTH_ENTRY_INVALID', 'AUTH_ENTRY_INVALID']);
  assert.deepEqual(coded(await w.call(w.I1, 'entry', { body: { proof } })), [401, 'AUTH_CREDENTIALS_MISSING', 'AUTH_CREDENTIALS_MISSING']);
  assert.deepEqual(coded(await w.call(w.I1, 'entry', { sid, body: { proof }, csrf: false })), [403, 'AUTH_CSRF_REQUIRED', 'AUTH_CSRF_REQUIRED']);
  // The cookie changed between the callback and the entry (another login): this proof does not enter that session.
  const second = await login(w, w.I2, await w.issue('e2', { sub: 'syn-sub-e2', groups: [B] }));
  assert.deepEqual(coded(await w.call(w.I1, 'entry', { sid: second.done.newSid, body: { proof } })), [403, 'AUTH_ENTRY_REFUSED', 'AUTH_ENTRY_REFUSED']);
  // The record cannot be written: 500, nothing consumed - the same proof still enters afterwards.
  w.fault('I1', 'tx.audit', dbError('entry'));
  assert.ok(storageFailure(await w.call(w.I1, 'entry', { sid, body: { proof } })));
  assert.deepEqual(await entries(s), []);
  const entered = await w.call(w.I1, 'entry', { sid, body: { proof } });
  assert.deepEqual([entered.status, Object.keys(entered.body), typeof entered.body.sessionId, entered.cookie], [200, ['sessionId'], 'string', 'K']);
  assert.deepEqual(await entries(s), [{ actor: 'syn-e1@synthetic.test', action: 'auth.entry', target: s,
    detail: { institution: A, ip: IP, dataSubject: null } }]);
  // The id it answers is the session's id: a bound `me` answers the same, and requests bound with it work.
  const me = await w.call(w.I1, 'me', { sid, binding: entered.body.sessionId });
  assert.deepEqual([me.status, me.body.sessionId, (await w.call(w.I2, 'get', { sid, binding: entered.body.sessionId })).status], [200, entered.body.sessionId, 200]);
  // Replay, on any instance: refused with the same answer as any other unusable proof; no second record.
  for (const inst of [w.I1, w.I2])
    assert.deepEqual(coded(await w.call(inst, 'entry', { sid, body: { proof } })), [403, 'AUTH_ENTRY_REFUSED', 'AUTH_ENTRY_REFUSED']);
  assert.equal((await entries(s)).length, 1);
  // A proof is short-lived: 120 s after its login it no longer enters. The session itself is not affected - a document
  // without a proof (a second tab, a reload) enters by its bootstrap.
  w.tick(121_000);
  assert.deepEqual(coded(await w.call(w.I2, 'entry', { sid: second.done.newSid, body: { proof: second.done.proof } })), [403, 'AUTH_ENTRY_REFUSED', 'AUTH_ENTRY_REFUSED']);
  const tab = await w.call(w.I2, 'me', { sid: second.done.newSid });
  assert.deepEqual([tab.status, typeof tab.body.sessionId, await entries('syn-sub-e2')], [200, 'string', []]);
  // A member waiting for approval can enter, is told so with the id it needs, and can log out with it.
  const pending = await login(w, w.I1, await w.issue('e3', { sub: 'syn-sub-e3', groups: [] }));
  const pe = await w.call(w.I1, 'entry', { sid: pending.done.newSid, body: { proof: pending.done.proof } });
  const pm = await w.call(w.I1, 'me', { sid: pending.done.newSid });
  assert.deepEqual([pe.status, pm.status, pm.body?.code, pm.body?.sessionId === pe.body.sessionId], [200, 403, 'INSTITUTION_PENDING', true]);
  const out = await w.call(w.I1, 'logout', { sid: pending.done.newSid, binding: pe.body.sessionId });
  assert.deepEqual([out.status, out.cookie, await w.version(pending.done.newSid)], [204, 'K', null]);
  assert.equal(w.faults.length, 0, 'the injected failure was reached');
  await w.finish('U5S-REQ-09', { output: markers('entry') });
});

// ── U5E: the session end is completed (S7-U5 session-end design v2, 2026-10-05; rules R1 and R2) ──
// REQ-S7-U5-SESSION-END (R1: whenever the product ends a product session, the provider session it was born from ends
// too, and a provider session the product decided to end never produces a product session again; R2: a login the
// person started to leave, to switch, or from a browser that cannot say whether they left, makes a session only from an
// authentication with credentials entered after that press)
//   -> RISK-S7-U5-SILENT-REENTRY (the next person at the PC enters as the previous doctor without a form)
//   -> TEST-S7-U5-END (the cases below; the real-Keycloak half is tests/live/session_end_live.py).
// The order of the racing steps is fixed by barriers (a held /token answer, a gate before a statement or inside the
// critical section), never by timing. The expected values are the design's literals. `idpOf(account)` is the provider
// session every token of that account carries unless the case names another.
const idpOf = sub => 'syn-idp-' + sub;

test('U5E-01 (acceptance 1) a callback that exchanged its code before a Log out completed makes no session when it resumes', async t => {
  const w = await world(t);
  const s = 'syn-sub-u5e1', X = idpOf(s);
  const sid = await w.session(await w.issue('u5e1-v1', { sub: s, groups: [A] }));
  // C: a second tab's login. The provider answered without a form (the SSO is alive); the callback has exchanged the
  // code and verified the token, and is held before the transaction that would create S2.
  const begin = await w.call(w.I2, 'login');
  const gate = w.gate('I2', 'tx.open');
  const exchanged = kc.tokens;
  const heldC = answerFlow(w, w.I2, begin, await w.issue('u5e1-v2', { sub: s, groups: [A] }));
  await gate.arrived();
  assert.deepEqual([kc.tokens - exchanged, await w.sessions()], [1, 1], 'C holds a verified token and has created nothing yet');
  // L: the Log out of S1 completes meanwhile.
  const out = await w.call(w.I1, 'logout', { sid });
  assert.deepEqual([out.status, await w.sessions(), (await w.marks()).map(m => m.slice(0, 2))], [204, 0, [[X, 'logout']]]);
  gate.release();
  const done = await heldC;
  // C resumes after L: no product session, no kin_sid, no entry proof. The provider session is ended (again) and the
  // login starts over once - this time the provider has no session, so the person meets the form.
  assert.deepEqual([done.status, atProvider(done), promptOf(done), done.newSid, done.proof, done.cookie, await w.sessions()],
    [302, true, null, null, undefined, 'P', 0]);
  assert.deepEqual(summary(rowsOf(await w.rows(), s)), [['auth.login', 'idp_session_ended', A], ['auth.logout', 'logout', A]]);
  assert.ok(kc.ended.includes(X) && (await w.mark(X)).confirmedAt, 'the provider session is ended and the mark says so');
  // The restarted flow: if the same ended provider session answers again (it survived its end), the person is sent to
  // the landing instead of round and round; credentials on the form (a new provider session) enter.
  const zombie = await answerFlow(w, w.I2, done, await w.issue('u5e1-v3', { sub: s, groups: [A] }));
  assert.deepEqual([zombie.status, zombie.location, zombie.newSid, await w.sessions()], [302, landing('end_unconfirmed'), null, 0]);
  const again = await w.call(w.I2, 'login');
  const entered = await answerFlow(w, w.I2, again, await w.issue('u5e1-v4', { sub: s, groups: [A], idp: X + '-new' }));
  assert.deepEqual([entered.status, entered.cookie, !!entered.proof, await w.sessions()], [302, 'S', true, 1]);
  await w.finish('U5E-01');
});

test('U5E-02 (acceptance 2) a session a callback created first on the same provider session ends with the Log out of its sibling; a row from before the column too', async t => {
  const w = await world(t);
  const s = 'syn-sub-u5e2', X = idpOf(s);
  const s1 = await w.session(await w.issue('u5e2-v1', { sub: s, groups: [A] }));
  // C first: the browser lost its cookie, the SSO answered without a form, S2 exists on the same provider session.
  const c = await login(w, w.I2, await w.issue('u5e2-v2', { sub: s, groups: [B] }));
  const s2 = c.done.newSid;
  assert.deepEqual([await w.sessions(), !!s2], [2, true]);
  const asked = kc.logouts;
  const out = await w.call(w.I1, 'logout', { sid: s1 });
  assert.deepEqual([out.status, await w.sessions(), await w.told() - asked], [204, 0, 1], 'both rows gone, the provider told once');
  // One record per product row really ended, each with its own recorded institution; no row twice.
  assert.deepEqual(await endsOf(w, s), [['auth.logout', 'logout', A], ['auth.logout', 'logout', B]]);
  const after = await w.call(w.I2, 'get', { sid: s2 });
  assert.deepEqual([...coded(after), after.cookie], [401, 'AUTH_SESSION_ENDED', 'AUTH_SESSION_ENDED', 'K']);
  assert.deepEqual(await w.marks(), [[X, 'logout', true]]);
  // A session stored before the column existed (idpSid empty): its end reads the provider session from its stored token.
  const old = 'syn-sub-u5e2-old';
  const legacy = await w.session(await w.issue('u5e2-old', { sub: old, groups: [A] }), { legacy: true });
  assert.equal((await w.call(w.I1, 'logout', { sid: legacy })).status, 204);
  await w.told();
  assert.deepEqual([(await w.marks()).find(m => m[0] === idpOf(old)), kc.endRequests.includes(idpOf(old))], [[idpOf(old), 'logout', true], true]);
  await w.finish('U5E-02');
});

test('U5E-03 (acceptance 3) the same doctor on two PCs: the Log out of one leaves the other working, also after its refresh; a Bearer token of the ended provider session is refused, any other is not', async t => {
  const w = await world(t);
  const s = 'syn-sub-u5e3';
  const pc1 = await w.issue('u5e3-pc1', { sub: s, groups: [A], idp: 'syn-idp-pc1' });
  const pc2 = await w.issue('u5e3-pc2', { sub: s, groups: [A], idp: 'syn-idp-pc2' });
  const pc2next = await w.issue('u5e3-pc2-next', { sub: s, groups: [A], idp: 'syn-idp-pc2' });
  const sid1 = await w.session(pc1), sid2 = await w.session(pc2, { atExpiresAt: lapsed() });
  assert.equal((await w.call(w.I1, 'logout', { sid: sid1 })).status, 204);
  await w.told();
  kc.auto = chainAnswers(new Map([[pc2.refresh, pc2next]]));
  const other = await w.call(w.I2, 'get', { sid: sid2 });
  kc.auto = null;
  assert.deepEqual([other.status, await w.version(sid2), await w.marks(), kc.endRequests], [200, 'u5e3-pc2-next', [['syn-idp-pc1', 'logout', true]], ['syn-idp-pc1']],
    'PC2 goes on with a refreshed token of its own provider session; only PC1\'s was ended');
  // Bearer: the stored token of the ended session is still validly signed - and refused; PC2's is not.
  const refused = await w.call(w.I1, 'get', { bearer: pc1.access });
  assert.deepEqual(coded(refused), [401, 'AUTH_SESSION_ENDED', 'AUTH_SESSION_ENDED']);
  assert.equal((await w.call(w.I1, 'get', { bearer: pc2next.access })).status, 200);
  // A token without a provider session (a service account) is not the Bearer check's subject.
  const service = await w.issue('u5e3-service', { sub: 'syn-sub-u5e3-service', groups: [A], idp: null });
  assert.equal((await w.call(w.I1, 'get', { bearer: service.access })).status, 200);
  // The mark cannot be read: the Bearer request fails closed with the fixed storage answer.
  w.fault('I1', 'mark.findUnique', dbError('bearer-mark'));
  assert.ok(storageFailure(await w.call(w.I1, 'get', { bearer: pc2next.access })));
  // A refresh that answers with another provider session's token is not this session's: not stored, nothing ended.
  const sid3 = await w.session(await w.issue('u5e3-v', { sub: s, groups: [A], idp: 'syn-idp-pc3' }), { atExpiresAt: lapsed() });
  kc.auto = () => reply.tokens(pc2next);
  const strange = await w.call(w.I1, 'get', { sid: sid3 });
  kc.auto = null;
  assert.deepEqual([...coded(strange), await w.version(sid3)], [503, 'AUTH_IDP_UNAVAILABLE', 'AUTH_IDP_UNAVAILABLE', 'u5e3-v']);
  await w.finish('U5E-03', { output: markers('bearer-mark') });
});

test('U5E-04 the end marks a provider session only after its end condition holds again under the lock; a lost race or a rollback leaves no mark and tells the provider nothing', async t => {
  const w = await world(t);
  // (a) an idle end that loses to a touch: judged idle, held before its transaction, touched meanwhile.
  let s = 'syn-sub-u5e4-idle';
  let sid = await w.session(await w.issue(s, { sub: s, groups: [A] }), { lastSeenAt: past(13 * HOUR) });
  let gate = w.gate('I1', 'tx.open');
  let held = w.call(w.I1, 'get', { sid });
  await gate.arrived();
  await w.base.authSession.updateMany({ where: { sid }, data: { lastSeenAt: new Date() } });
  gate.release();
  let out = await held;
  assert.deepEqual([out.status, await w.version(sid), await w.marks(), kc.endRequests, await endsOf(w, s)], [200, s, [], [], []],
    'the session was touched: not ended, no mark, the provider not told');
  // (b) a Log out whose three deletes lose to refreshes: 409, no mark, the provider not told.
  s = 'syn-sub-u5e4-busy';
  ({ out, sid } = await interleavedEnds(w, { s, kind: 'logout', rounds: 3 }));
  assert.deepEqual([out.status, !!(await w.version(sid)), await w.marks(), kc.endRequests], [409, true, [], []]);
  // (c) rollback: the mark write or the record fails inside the end transaction - nothing of it stays.
  for (const point of ['tx.mark', 'tx.audit']) {
    s = 'syn-sub-u5e4-' + point;
    sid = await w.session(await w.issue(s, { sub: s, groups: [B] }));
    w.fault('I1', point, dbError('end-' + point));
    out = await w.call(w.I1, 'logout', { sid });
    assert.ok(storageFailure(out), point);
    assert.deepEqual([await w.version(sid), await w.mark(idpOf(s)), kc.endRequests, await endsOf(w, s)], [s, null, [], []], point);
  }
  // (d) the lock, L first: the Log out is inside its critical section (lock taken, before its delete). A callback of
  // the same provider session does not get to read the mark until L commits - then it finds it.
  s = 'syn-sub-u5e4-l-first';
  sid = await w.session(await w.issue(s + '-v1', { sub: s, groups: [A] }));
  const begin = await w.call(w.I2, 'login');
  gate = w.gate('I1', 'tx.delete');
  held = w.call(w.I1, 'logout', { sid });
  await gate.arrived();
  let reads = w.calls.filter(c => c === 'I2:tx.markRead').length;
  const heldC = answerFlow(w, w.I2, begin, await w.issue(s + '-v2', { sub: s, groups: [A] }));
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(w.calls.filter(c => c === 'I2:tx.markRead').length, reads, 'the callback waits for the lock the Log out holds');
  gate.release();
  assert.equal((await held).status, 204);
  const blocked = await heldC;
  assert.deepEqual([blocked.newSid, blocked.cookie, atProvider(blocked), await w.base.authSession.count({ where: { sub: s } })], [null, 'P', true, 0]);
  // (e) the lock, C first: the callback is inside its critical section (mark read: none; before its create). The Log
  // out of the sibling does not delete until C commits - then it ends both rows.
  s = 'syn-sub-u5e4-c-first';
  sid = await w.session(await w.issue(s + '-v1', { sub: s, groups: [A] }));
  const begin2 = await w.call(w.I2, 'login');
  gate = w.gate('I2', 'tx.create');
  const heldC2 = answerFlow(w, w.I2, begin2, await w.issue(s + '-v2', { sub: s, groups: [A] }));
  await gate.arrived();
  const deletes = w.calls.filter(c => c === 'I1:tx.delete').length;
  held = w.call(w.I1, 'logout', { sid });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(w.calls.filter(c => c === 'I1:tx.delete').length, deletes, 'the Log out waits for the lock the callback holds');
  gate.release();
  const created = await heldC2;
  assert.deepEqual([created.cookie, (await held).status], ['S', 204]);
  assert.deepEqual([await w.version(created.newSid), await endsOf(w, s)], [null, [['auth.logout', 'logout', A], ['auth.logout', 'logout', A]]],
    'the session the callback created first is ended by the Log out that waited for it');
  assert.equal(w.faults.length, 0, 'every injected failure was reached');
  await w.finish('U5E-04', { output: ['end-tx.mark', 'end-tx.audit'].flatMap(markers) });
});

test('U5E-05 (acceptance 5) an end the provider did not confirm survives a restart: the mark blocks a callback at once, a new process resumes the end, retries back off and add no record', async t => {
  const w = await world(t);
  const s = 'syn-sub-u5e5', X = idpOf(s);
  const sid = await w.session(await w.issue('u5e5-v1', { sub: s, groups: [A] }));
  // The admin API is down (its connection refused: the request never sent) while the end commits (the process then dies:
  // nothing in memory is left of the attempt).
  kc.logoutMode = 'refused';
  const out = await w.call(w.I1, 'logout', { sid });
  await w.told();
  assert.deepEqual([out.status, await w.marks(), kc.ended], [204, [[X, 'logout', false]], []], 'ended and recorded; the provider end unconfirmed');
  // A callback of that provider session before the restart: blocked by the mark although the token endpoint works.
  const begin = await w.call(w.I2, 'login');
  const early = await answerFlow(w, w.I2, begin, await w.issue('u5e5-v2', { sub: s, groups: [A] }));
  assert.deepEqual([early.status, early.location, early.newSid, await w.sessions()], [302, landing('end_unconfirmed'), null, 0]);
  await w.told();
  const rows = (await w.rows()).length;
  // The restart: a new process, the provider reachable again. Its start resumes the unconfirmed end whatever its due time.
  kc.logoutMode = 'ok';
  const asked = kc.logouts;
  const restarted = w.instance('R');
  restarted.service.onModuleInit();
  try {
    await w.until('the resumed provider end', async () => (await w.mark(X)).confirmedAt !== null);
    assert.deepEqual([kc.ended, kc.logouts - asked, (await w.rows()).length], [[X], 1, rows], 'ended at the provider by one request; no record added');
    // The periodic retry: an end that keeps failing is asked again at growing intervals and never dropped.
    const s2 = 'syn-sub-u5e5-retry', Y = idpOf(s2);
    kc.logoutMode = 'refused';
    assert.equal((await w.call(w.I1, 'logout', { sid: await w.session(await w.issue(s2, { sub: s2, groups: [B] })) })).status, 204);
    await w.told();
    const count = () => kc.endRequests.filter(x => x === Y).length;
    assert.deepEqual([count(), (await w.mark(Y)).attempts], [1, 1]);
    w.tick(4000);
    await w.told();
    assert.equal(count(), 1, 'not before its due time');
    w.tick(1000);
    await w.until('the second attempt', async () => count() === 2);
    await w.told();
    w.tick(5000);
    await w.told();
    assert.equal(count(), 2, 'the interval has grown');
    kc.logoutMode = 'ok';
    w.tick(5000);
    await w.until('the confirmed retry', async () => (await w.mark(Y)).confirmedAt !== null);
    assert.deepEqual([count(), await endsOf(w, s2)], [3, [['auth.logout', 'logout', B]]]);
    // Keeping: a confirmed mark goes once no token of that provider session can exist (13 h after its confirmation - here
    // the decision and the confirmation are one instant; U5E-21 g separates them); an unconfirmed one is never dropped for its age.
    const at = hours => new Date(Date.now() - hours * HOUR);
    kc.logoutMode = 'refused';
    for (const [idp, decided, confirmed] of [['syn-idp-old-confirmed', 14, true], ['syn-idp-recent-confirmed', 11, true], ['syn-idp-old-open', 14, false]])
      await w.base.idpSessionEnd.create({ data: { idpSid: idp, cause: 'logout', decidedAt: at(decided), confirmedAt: confirmed ? at(decided) : null,
        attempts: 9, nextAttemptAt: new Date(Date.now() + 2 * HOUR) } });
    w.tick(HOUR);
    await w.until('the sweep of old confirmed marks', async () => (await w.mark('syn-idp-old-confirmed')) === null);
    assert.deepEqual((await w.marks()).filter(m => m[0].startsWith('syn-idp-old') || m[0].startsWith('syn-idp-recent')),
      [['syn-idp-old-open', 'logout', false], ['syn-idp-recent-confirmed', 'logout', true]]);
  } finally {
    restarted.service.onModuleDestroy();
    kc.logoutMode = 'ok';
  }
  await w.finish('U5E-05');
});

// S7-U5 D600: the answer of an end request that was carried out is lost (the connection cut after the provider ended the
// session). That request's outcome is unknown and only its own answer could settle it - it is gone. Another request for
// the same provider session that answers "no such session" does not settle it, nor do a restart and an hour: the mark stays
// unconfirmed, so every authentication of that sid stays refused (a late landing of the lost request would end the next SSO
// that got the sid). The first cause and time stay, no record is added.
test('U5E-06 a lost answer of the provider end stays unknown: the end is asked again, "no such session" does not confirm it, the sid stays refused after a restart and an hour; the first cause and time stay, no record is added', async t => {
  const w = await world(t);
  // The service token the admin call holds has died (Keycloak restarted): re-acquired once inside the same bounded call.
  // (First, while the clock has not moved: a token of this process is still fresh.)
  const s2 = 'syn-sub-u5e6-stale';
  assert.equal((await w.call(w.I1, 'logout', { sid: await w.session(await w.issue(s2 + '-warm', { sub: s2 + '-warm', groups: [A] })) })).status, 204);
  await w.told();
  kc.serviceMode = 'stale';
  const tokens = kc.serviceTokens;
  assert.equal((await w.call(w.I1, 'logout', { sid: await w.session(await w.issue(s2, { sub: s2, groups: [A] })) })).status, 204);
  await w.told();
  await w.until('the end after the re-acquired token confirmed', async () => (await w.mark(idpOf(s2)))?.confirmedAt != null);
  assert.deepEqual([(await w.marks()).find(m => m[0] === idpOf(s2)), kc.serviceTokens - tokens], [[idpOf(s2), 'logout', true], 1]);
  const s = 'syn-sub-u5e6', X = idpOf(s);
  const sid = await w.session(await w.issue(s, { sub: s, groups: [A] }));
  kc.logoutMode = 'lost';
  assert.equal((await w.call(w.I1, 'logout', { sid })).status, 204);
  await w.told();
  const first = await w.mark(X);
  assert.deepEqual([kc.ended.includes(X), first.confirmedAt, first.cause, await w.changes(X)], [true, null, 'logout', ['unknown']],
    'the provider ended it; the product does not know - that request stays unknown');
  kc.logoutMode = 'ok';
  w.tick(60_000);
  const restarted = w.instance('R');
  restarted.service.onModuleInit();
  try {
    // A new process asks again: "no such session" answers that request - and only that one.
    await w.until('the end asked again and answered', async () => (await w.changes(X)).length === 2 && (await w.changes(X))[1] === 'done');
    w.tick(HOUR);
    await quiet(w);
    const asked = await w.changes(X);
    assert.deepEqual([asked[0], asked.slice(1).every(state => state === 'done'), (await w.mark(X)).confirmedAt], ['unknown', true, null],
      'the lost request stays unknown after another request\'s 404, a restart and an hour; the mark stays unconfirmed');
    // The sid's next authentication is refused: no session while the lost request may still land.
    const begin = await w.call(w.I2, 'login');
    const again = await answerFlow(w, w.I2, begin, await w.issue('u5e6-again', { sub: s, groups: [A] }));
    assert.deepEqual([again.location, again.newSid, await w.sessions()], [landing('end_unconfirmed'), null, 0]);
  } finally {
    restarted.service.onModuleDestroy();
  }
  const mark = await w.mark(X);
  assert.deepEqual([mark.cause, mark.decidedAt.getTime(), mark.confirmedAt, await endsOf(w, s)],
    ['logout', first.decidedAt.getTime(), null, [['auth.logout', 'logout', A]]]);
  await w.finish('U5E-06');
});

test('U5E-07 (acceptance 4, R2) a re-authentication intent starts by POST, probes and ends the SSO without making a session, and only the fresh step enters', async t => {
  const w = await world(t);
  const s = 'syn-sub-u5e7', X = idpOf(s);
  // The browser cannot say whether the doctor left (storage untrusted), its product cookie is gone (401), the SSO of
  // doctor A is alive, and A's product session S1 of that SSO still exists server-side.
  const s1 = await w.session(await w.issue('u5e7-a', { sub: s, groups: [A] }));
  // Without the CSRF header nothing starts.
  const forged = await w.call(w.I1, 'switch', { body: UNTRUSTED, csrf: false });
  assert.deepEqual([...coded(forged), forged.pending], [403, 'AUTH_CSRF_REQUIRED', 'AUTH_CSRF_REQUIRED', null]);
  const begin = await w.call(w.I1, 'switch', { body: UNTRUSTED });
  assert.deepEqual([begin.status, begin.cookie, promptOf(begin)], [200, 'P', 'none'], 'the probe step: no screen, the SSO is only identified');
  // The provider answers the probe with a code (A's SSO). No session, no proof: that SSO is ended, with A's product session.
  const probed = await answerFlow(w, w.I1, begin, await w.issue('u5e7-a2', { sub: s, groups: [A] }));
  assert.deepEqual([probed.status, atProvider(probed), promptOf(probed), probed.newSid, probed.proof, await w.sessions(), await w.version(s1)],
    [302, true, 'login', null, undefined, 0, null]);
  assert.deepEqual([await w.marks(), kc.ended], [[[X, 'reauthentication', true]], [X]]);
  const ended = rowsOf(await w.rows(), s);
  assert.deepEqual([summary(ended), ended[0].detail.trigger], [[['auth.logout', 'reauthentication', A]], 'storage_untrusted'], 'no login row: a probe is not a login');
  // The fresh step: the next person types credentials (a new provider session) and enters.
  const b = 'syn-sub-u5e7-b';
  const fresh = await answerFlow(w, w.I1, probed, await w.issue('u5e7-b', { sub: b, groups: [B] }));
  assert.deepEqual([fresh.status, fresh.cookie, !!fresh.proof, fresh.location.split('#')[0]], [302, 'S', true, ORIGIN + '/worklist/hpacs-lite/main.html']);
  assert.deepEqual([(await w.base.authSession.findUnique({ where: { sid: fresh.newSid } })).idpSid, summary(rowsOf(await w.rows(), b))],
    [idpOf(b), [['auth.login', 'success', B]]]);
  // No SSO to end: the probe comes back login_required and the flow goes on to the fresh step; nothing is recorded.
  const rows = (await w.rows()).length;
  const begin2 = await w.call(w.I2, 'switch', { body: UNREADABLE });
  const none = await refuseFlow(w, w.I2, begin2, 'login_required');
  assert.deepEqual([none.status, atProvider(none), promptOf(none), none.cookie, (await w.rows()).length], [302, true, 'login', 'P', rows]);
  // Any other answer of the probe (here interaction_required) has not identified the SSO - it is neither "no SSO" nor a
  // licence to enter (SEA-F07). The probe is asked once more; a second such answer goes on to the fresh step
  // (prompt=login, commander's decision of fix round 1): only credentials entered there make a session - never the
  // probe step, never a plain login, and no dead end at the landing.
  const live3 = await w.sessions();
  const begin3 = await w.call(w.I2, 'switch', { body: UNREADABLE });
  const retried3 = await refuseFlow(w, w.I2, begin3, 'interaction_required');
  assert.deepEqual([retried3.status, atProvider(retried3), promptOf(retried3), retried3.newSid, retried3.cookie, (await w.rows()).length],
    [302, true, 'none', null, 'P', rows], 'one more probe, nothing recorded yet');
  const fresh3 = await refuseFlow(w, w.I2, retried3, 'interaction_required');
  assert.deepEqual([fresh3.status, atProvider(fresh3), promptOf(fresh3), fresh3.newSid, fresh3.proof, await w.sessions(), (await w.rows()).length],
    [302, true, 'login', null, undefined, live3, rows], 'the fresh step: credentials required; the probe step made no session');
  const d = 'syn-sub-u5e7-d';
  const entered3 = await answerFlow(w, w.I2, fresh3, await w.issue('u5e7-d', { sub: d, groups: [B] }));
  assert.deepEqual([entered3.cookie, !!entered3.proof, await w.sessions(), summary(rowsOf(await w.rows(), d))],
    [ 'S', true, live3 + 1, [['auth.login', 'success', B]]], 'credentials entered at the fresh step: the session');
  // Only an answer that the provider itself is down ends at the landing with the sentence; the intent stays with the
  // browser meanwhile (a plain start is the probe again) and the same press works again.
  const begin4a = await w.call(w.I2, 'switch', { body: UNREADABLE });
  const retried4a = await refuseFlow(w, w.I2, begin4a, 'temporarily_unavailable');
  const down = await refuseFlow(w, w.I2, retried4a, 'temporarily_unavailable');
  assert.deepEqual([promptOf(retried4a), down.location, down.newSid, (await w.rows()).at(-1).detail.cause],
    ['none', landing('sso_unidentified'), null, 'provider_error']);
  assert.ok(down.pendingCookie, 'the intent is kept with the browser');
  const link3 = await w.call(w.I2, 'login', { cookie: down.pendingCookie });
  assert.deepEqual([link3.status, promptOf(link3)], [302, 'none'], 'a plain start meanwhile does not ride the unidentified SSO');
  assert.equal(await w.sessions(), live3 + 1, 'no session from the probe steps');
  // The provider end cannot be confirmed (the admin API is down, the token endpoint works): no fresh step - the
  // landing says so, the SSO stays marked, and the same press works once the provider answers.
  const c = 'syn-sub-u5e7-c', Z = idpOf(c);
  kc.logoutMode = 'refused';
  const begin4 = await w.call(w.I1, 'switch', { body: UNTRUSTED });
  const unconfirmed = await answerFlow(w, w.I1, begin4, await w.issue('u5e7-c', { sub: c, groups: [A] }));
  assert.deepEqual([unconfirmed.location, unconfirmed.newSid, (await w.marks()).find(m => m[0] === Z)], [landing('end_unconfirmed'), null, [Z, 'reauthentication', false]]);
  kc.logoutMode = 'ok';
  const begin5 = await w.call(w.I1, 'switch', { body: UNTRUSTED });
  const retried = await answerFlow(w, w.I1, begin5, await w.issue('u5e7-c2', { sub: c, groups: [A] }));
  assert.deepEqual([atProvider(retried), promptOf(retried), (await w.marks()).find(m => m[0] === Z)], [true, 'login', [Z, 'reauthentication', true]]);
  await w.finish('U5E-07');
});

test('U5E-08 a re-authentication intent this browser holds is not downgraded by a link, a registration or another tab\'s plain login; the fresh login that fulfils it clears it', async t => {
  const w = await world(t);
  const s = 'syn-sub-u5e8', X = idpOf(s);
  // A plain login was already on its way in tab 0 (the provider form or an SSO answer pending).
  const plain = await w.call(w.I1, 'login');
  assert.equal(promptOf(plain), null);
  // The landing of tab 1 declares the intent.
  const intent = await w.call(w.I1, 'switch', { body: UNTRUSTED });
  assert.equal(promptOf(intent), 'none');
  // Tab 2 starts by a link, tab 3 opens the registration - with the browser's cookies: both start as the same intent.
  const jar = [plain.pendingCookie, intent.pendingCookie];
  const link = await w.call(w.I2, 'login', { cookie: jar.join('; ') });
  const signup = await w.call(w.I2, 'register', { cookie: jar.join('; ') });
  assert.deepEqual([promptOf(link), promptOf(signup), link.consumed, signup.consumed], ['none', 'none', [], []],
    'no plain start while the intent is pending; nobody else\'s flow is consumed');
  // Tab 0's plain flow comes back with a code of the live SSO: it is handled as the probe - no session, the SSO ended.
  const early = await answerFlow(w, w.I1, plain, await w.issue('u5e8-a', { sub: s, groups: [A] }), { cookies: [intent.pendingCookie] });
  assert.deepEqual([early.newSid, atProvider(early), promptOf(early), await w.sessions(), await w.marks()],
    [null, true, 'login', 0, [[X, 'reauthentication', true]]]);
  assert.deepEqual(early.consumed.length, 1, 'a callback consumes its own flow only');
  // The registration tab: its probe finds no SSO any more and goes on to the registration form.
  const registered = await refuseFlow(w, w.I2, signup, 'login_required', { cookies: [intent.pendingCookie] });
  assert.deepEqual([atProvider(registered), promptOf(registered)], [true, 'create']);
  // The fresh login of tab 0 enters and clears the intent the other flows still carry: the next plain start is plain.
  const b = 'syn-sub-u5e8-b';
  const fresh = await answerFlow(w, w.I1, early, await w.issue('u5e8-b', { sub: b, groups: [B] }), { cookies: [intent.pendingCookie, link.pendingCookie] });
  assert.deepEqual([fresh.cookie, fresh.consumed.length], ['S', 3], 'its own flow and the two that carried the intent');
  assert.equal(promptOf(await w.call(w.I2, 'login')), null);
  await w.finish('U5E-08');
});

test('U5E-09 the bound start waits for the provider end: unconfirmed is 503 with the session ended and marked; the same press then goes through the probe', async t => {
  const w = await world(t);
  const s = 'syn-sub-u5e9', X = idpOf(s);
  const sid = await w.session(await w.issue('u5e9-v1', { sub: s, groups: [A] }));
  kc.logoutMode = 'refused';
  const out = await w.call(w.I1, 'switch', { sid, body: UNFINISHED });
  assert.deepEqual([...coded(out), out.cookie, out.pending, out.location], [503, 'AUTH_IDP_END_UNCONFIRMED', 'AUTH_IDP_END_UNCONFIRMED', 'K', null, null]);
  assert.deepEqual([await w.version(sid), await w.marks(), await endsOf(w, s)], [null, [[X, 'logout', false]], [['auth.logout', 'logout', A]]],
    'the product session is ended and recorded as the completion of the Log out; the SSO is marked');
  // An ordinary link meanwhile (the SSO is alive and answers without a form): blocked by the mark, no session.
  const link = await w.call(w.I2, 'login');
  const silent = await answerFlow(w, w.I2, link, await w.issue('u5e9-v2', { sub: s, groups: [A] }));
  assert.deepEqual([silent.location, silent.newSid, await w.sessions()], [landing('end_unconfirmed'), null, 0]);
  // The same press again, the provider back: the session is gone (the document's binding is of no use and not asked
  // for), so the SSO is probed, ended, and the fresh step follows. One record of the end in all.
  kc.logoutMode = 'ok';
  const again = await w.call(w.I1, 'switch', { sid, body: UNFINISHED, binding: null });
  assert.deepEqual([again.status, promptOf(again)], [200, 'none']);
  const probed = await answerFlow(w, w.I1, again, await w.issue('u5e9-v3', { sub: s, groups: [A] }), { sid });
  assert.deepEqual([atProvider(probed), promptOf(probed), await w.marks(), await endsOf(w, s)],
    [true, 'login', [[X, 'logout', true]], [['auth.logout', 'logout', A]]], 'the first cause stays; no second record');
  // The service account's token endpoint does not answer: the whole admin call is bounded, the start answers 503.
  const s2 = 'syn-sub-u5e9-hang';
  const sid2 = await w.session(await w.issue(s2, { sub: s2, groups: [B] }));
  const hung = w.instance('H');
  kc.serviceMode = 'hang';
  const from = performance.now();
  const slow = await w.call(hung, 'switch', { sid: sid2, body: SWITCH });
  kc.serviceMode = 'ok';
  assert.deepEqual([slow.status, slow.body?.code, performance.now() - from < 8000, await endsOf(w, s2)],
    [503, 'AUTH_IDP_END_UNCONFIRMED', true, [['auth.logout', 'account_switch', B]]]);
  await w.finish('U5E-09');
});

test('U5E-10 a callback is never answered with an error body: a stray one enters the live session or restarts once; a token that expired while the callback waited makes no session', async t => {
  const w = await world(t);
  const s = 'syn-sub-u5e10';
  // Back from the work document re-submits an old authorize answer while the session is alive: the work document.
  const live = await w.session(await w.issue('u5e10-live', { sub: s, groups: [A] }));
  const exchanged = kc.tokens;
  const back = await w.call(w.I1, 'callback', { sid: live, query: { code: 'syn-old-code', state: 'syn-old-state' } });
  assert.deepEqual([back.status, back.location, back.body, kc.tokens - exchanged, await w.sessions()],
    [302, ORIGIN + '/worklist/hpacs-lite/main.html', undefined, 0, 1]);
  // The verified token expires while the callback waits for its turn: after the lock it is looked at again.
  const b = 'syn-sub-u5e10-b';
  const begin = await w.call(w.I2, 'login');
  const gate = w.gate('I2', 'tx.open');
  const held = answerFlow(w, w.I2, begin, await w.issue('u5e10-short', { sub: b, groups: [B], expIn: 5 }));
  await gate.arrived();
  w.tick(6000);
  gate.release();
  const late = await held;
  assert.deepEqual([late.status, atProvider(late), late.newSid, await w.sessions(), rowsOf(await w.rows(), b)], [302, true, null, 1, []],
    'no session from the expired token; the login starts again once');
  const gate2 = w.gate('I2', 'tx.open');
  const held2 = answerFlow(w, w.I2, late, await w.issue('u5e10-short2', { sub: b, groups: [B], expIn: 5 }));
  await gate2.arrived();
  w.tick(6000);
  gate2.release();
  assert.deepEqual([(await held2).location, await w.sessions()], [landing('stale'), 1], 'the second time: the landing, not a loop');
  // A token that names no provider session cannot be bound to one: no session.
  const begin3 = await w.call(w.I2, 'login');
  const unbound = await answerFlow(w, w.I2, begin3, await w.issue('u5e10-nosid', { sub: b, groups: [B], idp: null }));
  assert.deepEqual([unbound.location, unbound.newSid, (await w.rows()).at(-1).detail.cause], [landing('login_failed'), null, 'token_invalid']);
  // The provider end of a session without a known provider session (an old row whose stored token is unreadable) is
  // not guessed: the row ends, with its record, and no mark is made.
  const odd = randomBytes(32).toString('base64url');
  w.secret('sid', odd);
  await w.base.authSession.create({ data: { sid: odd, sub: 'syn-sub-u5e10-odd', accessToken: 'syn-not-a-jwt', refreshToken: 'syn-rt-odd',
    atExpiresAt: new Date(Date.now() + HOUR), lastSeenAt: new Date() } });
  assert.equal((await w.call(w.I1, 'logout', { sid: odd })).status, 204);
  assert.deepEqual([await w.base.authSession.count({ where: { sid: odd } }), await w.marks(), summary(rowsOf(await w.rows(), 'syn-sub-u5e10-odd'))],
    [0, [], [['auth.logout', 'logout', null]]]);
  await w.finish('U5E-10');
});

// SEA-F02 (review A of 757e37f): design 5-0 item 4 - the first cause and decidedAt of a mark are never overwritten by a
// later end or a retry (the 13 h keep window counts from the last confirmation, U5E-21 g). The opposite side: a later end still re-wakes the
// provider end of a mark whose provider session produced a code again.
test('U5E-11 a later end keeps the first cause; an already-ended authentication never reopens its mark', async t => {
  const w = await world(t);
  const s = 'syn-sub-u5e11', X = idpOf(s);
  const sid = await w.session(await w.issue('u5e11-v1', { sub: s, groups: [A] }));
  kc.logoutMode = 'refused';
  assert.equal((await w.call(w.I1, 'logout', { sid })).status, 204);
  await w.told();
  const first = await w.mark(X);
  assert.deepEqual([first.cause, first.confirmedAt], ['logout', null], 'the doctor\'s Log out; the provider end not confirmed');
  // A minute later the SSO is still alive. This browser (its product cookie gone) presses Switch account: the probe finds
  // that SSO and ends it again - this time for account_switch - and the provider confirms.
  w.tick(60_000);
  kc.logoutMode = 'ok';
  const begin = await w.call(w.I1, 'switch', { body: SWITCH });
  const probed = await answerFlow(w, w.I1, begin, await w.issue('u5e11-v2', { sub: s, groups: [A] }));
  assert.deepEqual([atProvider(probed), promptOf(probed), probed.newSid], [true, 'login', null]);
  let mark = await w.mark(X);
  assert.deepEqual([mark.cause, mark.decidedAt.getTime(), mark.confirmedAt !== null], ['logout', first.decidedAt.getTime(), true],
    'the first cause and decision time stay; the end is now confirmed');
  // R10-O6: a delayed code of the confirmed authentication is refused without reopening the mark or sending a new DELETE.
  w.tick(60_000);
  kc.logoutMode = 'refused';
  const asked = kc.endRequests.filter(x => x === X).length;
  const begin2 = await w.call(w.I2, 'switch', { body: UNREADABLE });
  const probed2 = await answerFlow(w, w.I2, begin2, await w.issue('u5e11-v3', { sub: s, groups: [A] }));
  assert.deepEqual([probed2.location, probed2.newSid], [landing('stale'), null]);
  mark = await w.mark(X);
  assert.deepEqual([mark.cause, mark.decidedAt.getTime(), mark.confirmedAt !== null, kc.endRequests.filter(x => x === X).length - asked],
    ['logout', first.decidedAt.getTime(), true, 0], 'confirmed authentication stays ended; no new DELETE');
  kc.logoutMode = 'ok';
  assert.deepEqual(await endsOf(w, s), [['auth.logout', 'logout', A]], 'one record: the probes ended no product session');
  await w.finish('U5E-11');
});

// SEA-F03 (review A): the provider-session lock has a bounded wait (lock_timeout 3 s). A Log out that cannot get it answers
// 409 AUTH_SESSION_BUSY with nothing written; a callback that cannot get it answers the landing with no session. Only a
// real PostgreSQL (the CI runtime job) proves the lock itself; the case holds one side inside its transaction past the wait.
test('U5E-12 a provider-session lock held past its wait: the Log out answers 409 with no mark, record or provider call; a callback answers the landing with no session', async t => {
  const w = await world(t);
  // (a) the callback C holds the lock of X (inside its transaction: mark read, before its create) for longer than the wait.
  let s = 'syn-sub-u5e12-c';
  const X = idpOf(s);
  const sid = await w.session(await w.issue(s + '-v1', { sub: s, groups: [A] }));
  const begin = await w.call(w.I2, 'login');
  let gate = w.gate('I2', 'tx.create');
  const heldC = answerFlow(w, w.I2, begin, await w.issue(s + '-v2', { sub: s, groups: [A] }));
  await gate.arrived();
  // The held transaction is released whatever the assertions find: a failure here must not leave it holding its lock.
  let busy, waited, before;
  try {
    const from = performance.now();
    busy = await w.call(w.I1, 'logout', { sid });
    waited = performance.now() - from;
    before = [await w.version(sid), await w.mark(X), await endsOf(w, s), [...kc.endRequests]];
  } finally {
    gate.release();
  }
  const created = await heldC;
  assert.deepEqual([...coded(busy), busy.cookie], [409, 'AUTH_SESSION_BUSY', 'AUTH_SESSION_BUSY', 'K']);
  assert.ok(waited >= 2500 && waited < 10000, `the Log out waited for the lock and gave up by its bound (${Math.round(waited)} ms)`);
  assert.deepEqual(before, [s + '-v1', null, [], []], 'a lost lock wait ends nothing, leaves no mark or record and tells the provider nothing');
  assert.equal(created.cookie, 'S', 'the holder goes on');
  // The opposite side: the next Log out gets the lock and ends both rows of X.
  assert.equal((await w.call(w.I1, 'logout', { sid })).status, 204);
  assert.deepEqual([await w.version(created.newSid), (await w.mark(X)).cause, await endsOf(w, s)],
    [null, 'logout', [['auth.logout', 'logout', A], ['auth.logout', 'logout', A]]]);
  // (b) a Log out holds the lock of Y (inside its transaction: deleted, before its mark) for longer than the wait; a callback
  // of Y meanwhile cannot get the lock: the landing, no session, its failure row. The Log out then completes.
  s = 'syn-sub-u5e12-l';
  const Y = idpOf(s);
  const sidY = await w.session(await w.issue(s + '-v1', { sub: s, groups: [B] }));
  const beginY = await w.call(w.I2, 'login');
  gate = w.gate('I1', 'tx.mark');
  const heldL = w.call(w.I1, 'logout', { sid: sidY });
  await gate.arrived();
  let callback;
  try {
    const opened = w.calls.filter(c => c === 'I2:tx.open').length;
    callback = answerFlow(w, w.I2, beginY, await w.issue(s + '-v2', { sub: s, groups: [B] }));
    // Held for longer than the lock wait counted from the moment the callback asks for its transaction (the exchange
    // and the token check before it take their own time).
    await w.until('the callback asking for its transaction', async () => w.calls.filter(c => c === 'I2:tx.open').length > opened);
    await new Promise(resolve => setTimeout(resolve, 3600));
  } finally {
    gate.release();
  }
  const [ended, refused] = await Promise.all([heldL, callback]);
  assert.deepEqual([ended.status, refused.location, refused.newSid, await w.base.authSession.count({ where: { sub: s } })],
    [204, landing('login_failed'), null, 0]);
  assert.deepEqual([(await w.mark(Y)).cause, rowsOf(await w.rows(), s).filter(r => r.action === 'auth.login').map(r => r.detail.cause)],
    ['logout', ['session_failed']]);
  await w.finish('U5E-12');
});

// SEA-F08 (review A): R1 - no product path ends a session without the mark. An administrator's isolation of a member
// (suspend here; approval changes and their cancellation take the same isolate) ends the member's sessions through the
// same end: a mark per provider session, the provider told, one record per ended session with cause isolation. The
// member's other PCs end too - each provider session the provider lists is ended by its own id; there is no whole-user
// logout (S7-U5 D600). A callback that had exchanged its code before the isolation makes no session. Another member is
// untouched.
test('U5E-13 an administrator\'s isolation ends every session of the member through the same end: marks, provider end, records with cause isolation; a callback in flight makes no session', async t => {
  const w = await world(t);
  const { AdminService } = require('/app/dist/admin.service');
  const m = 'syn-sub-u5e13', other = 'syn-sub-u5e13-other';
  const P1 = 'syn-idp-u5e13-pc1', P2 = 'syn-idp-u5e13-pc2';
  kc.members[m] = { username: 'syn-member-u5e13', email: m + '@synthetic.test', enabled: true, groups: [A], roles: ['radiologist'] };
  const sid1 = await w.session(await w.issue('u5e13-pc1', { sub: m, groups: [A], idp: P1 }));
  const sid2 = await w.session(await w.issue('u5e13-pc2', { sub: m, groups: [A], idp: P2 }));
  const kept = await w.session(await w.issue('u5e13-other', { sub: other, groups: [A] }));
  // A login of the member on PC1 has exchanged its code (PC1's SSO answered without a form) and waits for its transaction.
  const begin = await w.call(w.I2, 'login');
  const gate = w.gate('I2', 'tx.open');
  const heldC = answerFlow(w, w.I2, begin, await w.issue('u5e13-pc1-again', { sub: m, groups: [A], idp: P1 }));
  await gate.arrived();
  // And on a third PC a first login of the member, a NEW provider session no product row knows, has exchanged its code
  // before the isolation too and commits after the cleanup. The provider lists the
  // member's live provider sessions: those of PC1, PC2 and PC3.
  const P3 = 'syn-idp-u5e13-pc3';
  kc.members[m].sessions = [P1, P2, P3];
  const I3 = w.instance('I3');
  const begin3 = await w.call(I3, 'login');
  const gate3 = w.gate('I3', 'tx.open');
  const heldNew = answerFlow(w, I3, begin3, await w.issue('u5e13-pc3', { sub: m, groups: [A], idp: P3 }));
  await gate3.arrived();
  const admin = new AdminService(w.I1.prisma, new KeycloakService(), null, w.I1.service);
  const after = await admin.patchUser(m, { enabled: false }, { roles: ['admin'], actor: 'syn-admin@synthetic.test', sub: 'syn-admin' });
  await w.told();
  assert.deepEqual([after.enabled, kc.members[m].enabled, kc.userLogouts, [P1, P2, P3].filter(sid => kc.ended.includes(sid))],
    [false, false, [], [P1, P2, P3]], 'disabled; every listed provider session ended by its own id, no whole-user logout');
  assert.deepEqual([await w.version(sid1), await w.version(sid2), await w.version(kept)], [null, null, 'u5e13-other']);
  assert.deepEqual(await w.marks(), [[P1, 'isolation', true], [P2, 'isolation', true], [P3, 'isolation', true]],
    'a mark for every provider session the provider lists - also the one no product row knows - confirmed');
  assert.deepEqual(await endsOf(w, m), [['auth.logout', 'isolation', A], ['auth.logout', 'isolation', A]], 'one record per ended session');
  // Whom the provider was asked to end, not how often: a session the provider still lists while the first end request
  // is on its way is asked again (designed and idempotent - a repeat is answered 404 and counts as confirmed). How often
  // that happens depends on the database's round trips, not on a contract.
  assert.deepEqual([...new Set(kc.endRequests)].sort(), [P1, P2, P3],
    'every provider session the isolation listed or ended is told (a repeat answered 404 is allowed)');
  gate.release();
  const late = await heldC;
  assert.deepEqual([late.newSid, late.proof, await w.base.authSession.count({ where: { sub: m } })], [null, undefined, 0],
    'the mark blocks the callback that had exchanged its code before the isolation');
  assert.equal(rowsOf(await w.rows(), m).filter(r => r.action === 'auth.login').at(-1).detail.cause, 'idp_session_ended');
  // The new provider session's callback commits after the cleanup: its provider session is marked (a recorded fact, not
  // a timing) - no session; its failure row says so.
  gate3.release();
  const isolated = await heldNew;
  assert.deepEqual([isolated.newSid, isolated.proof, await w.base.authSession.count({ where: { sub: m } })],
    [null, undefined, 0], 'a code exchanged before the isolation makes no session after it');
  assert.equal(rowsOf(await w.rows(), m).filter(r => r.action === 'auth.login').at(-1).detail.cause, 'idp_session_ended');
  // A surviving row is refused from the local fact before refresh. Authentication itself does not send a new DELETE;
  // an explicit ending remains available and uses the normal recorded ending path.
  const v = await w.issue('u5e13-left', { sub: m, groups: [A], idp: 'syn-idp-u5e13-left' });
  const left = await w.session(v, { atExpiresAt: lapsed() });
  const refreshRequests = kc.tokens, endRequests = kc.endRequests.length;
  kc.auto = () => reply.tokens(v);
  const refused = await w.call(w.I1, 'get', { sid: left });
  kc.auto = null;
  assert.deepEqual([...coded(refused), await w.version(left)], [401, 'AUTH_SESSION_ENDED', 'AUTH_SESSION_ENDED', 'u5e13-left']);
  assert.deepEqual([kc.tokens, kc.endRequests.length], [refreshRequests, endRequests], 'DB refusal precedes every provider exchange');
  assert.equal((await w.call(w.I1, 'logout', { sid: left })).status, 204);
  await w.told();
  assert.deepEqual([(await w.marks()).find(x => x[0] === 'syn-idp-u5e13-left'), (await endsOf(w, m)).length],
    [['syn-idp-u5e13-left', 'logout', true], 3]);
  // The isolation is our own recorded fact, its provider work done.
  assert.deepEqual((await w.base.memberIsolation.findMany()).map(r => [r.sub, r.providerDoneAt !== null]), [[m, true]]);
  // The opposite side: the other member's refresh goes on - also with the admin API out, which the refresh never asks.
  const ov = await w.issue('u5e13-other-next', { sub: other, groups: [A] });
  const oldOther = await w.session(await w.issue('u5e13-other-2', { sub: other, groups: [A] }), { atExpiresAt: lapsed() });
  kc.auto = () => reply.tokens(ov);
  kc.adminDown = true;
  const calls = kc.adminCalls.length;
  assert.deepEqual([(await w.call(w.I1, 'get', { sid: oldOther })).status, kc.adminCalls.length - calls], [200, 0]);
  kc.adminDown = false;
  kc.auto = null;
  await w.finish('U5E-13');
});

// Commander decisions on SEA-F08 (fix round 1): the isolation's marks are a recorded fact - re-activating the member
// (approval change, cancel, Activate) does not reopen a provider session the isolation listed. Integration round 6 (A):
// the login path reads no provider state at all - the member's isolation is our own fact (MemberIsolation).
test('U5E-14 a code exchanged before an isolation stays refused after the member is active again; the login path never asks the admin API', async t => {
  const w = await world(t);
  const { AdminService } = require('/app/dist/admin.service');
  const admin = new AdminService(w.I1.prisma, new KeycloakService(), null, w.I1.service);
  const caller = { roles: ['admin'], actor: 'syn-admin@synthetic.test', sub: 'syn-admin' };
  const m = 'syn-sub-u5e14', Q = 'syn-idp-u5e14-q';
  kc.members[m] = { username: 'syn-member-u5e14', email: m + '@synthetic.test', enabled: true, groups: [A], roles: ['radiologist'], sessions: [Q] };
  // The member's login has exchanged its code (no product row yet) and is held; the member is suspended and then made
  // active again before that login commits.
  const begin = await w.call(w.I2, 'login');
  const gate = w.gate('I2', 'tx.open');
  const held = answerFlow(w, w.I2, begin, await w.issue('u5e14-q', { sub: m, groups: [A], idp: Q }));
  await gate.arrived();
  try {
    assert.equal((await admin.patchUser(m, { enabled: false }, caller)).enabled, false);
    assert.equal((await admin.patchUser(m, { enabled: true }, caller)).enabled, true);
  } finally {
    gate.release();
  }
  const late = await held;
  assert.deepEqual([kc.members[m].enabled, late.newSid, late.proof, await w.base.authSession.count({ where: { sub: m } })],
    [true, null, undefined, 0], 'active again, and still no session from the provider session the isolation marked');
  assert.deepEqual([(await w.marks()).find(x => x[0] === Q)?.slice(0, 2), rowsOf(await w.rows(), m).at(-1).detail.cause],
    [[Q, 'isolation'], 'idp_session_ended']);
  // The re-activation finished: our fact is gone (only a finished re-activation removes it).
  assert.equal(await w.base.memberIsolation.count({ where: { sub: m } }), 0);
  // A new login after the re-activation (a new provider session, credentials entered) enters as usual.
  const again = await login(w, w.I2, await w.issue('u5e14-new', { sub: m, groups: [A], idp: 'syn-idp-u5e14-new' }));
  assert.deepEqual([again.done.cookie, !!again.done.proof], ['S', true]);
  // The admin API out: an ordinary login enters, asks it nothing, and its success row is the ordinary one.
  const u = 'syn-sub-u5e14-out';
  kc.adminDown = true;
  const calls = kc.adminCalls.length;
  const out = await login(w, w.I2, await w.issue('u5e14-u', { sub: u, groups: [A] }));
  kc.adminDown = false;
  assert.deepEqual([out.done.cookie, !!out.done.proof, kc.adminCalls.length - calls], ['S', true, 0]);
  assert.deepEqual(rowsOf(await w.rows(), u).map(r => r.detail.outcome), ['success']);
  await w.finish('U5E-14');
});

// Integration round 6 (A): the reviewers' counter-example to "an unreadable member state lets the login through" -
// the disable succeeded, the session listing failed, nothing was marked, the state read fails, and a code exchanged
// before the isolation passes. The rule now: the isolation FIRST writes our own durable fact, THEN does the provider work;
// the callback and the refresh read only that fact; the retry cycle finishes unfinished provider work from the fact; only
// a finished re-activation removes it. Every interleaving the reviewers named makes no session.
test('U5E-15 isolation is our own fact written before any provider work: listing or disabling fails, a code exchanged before it, a re-activation in between - no session; the cycle finishes the provider work', async t => {
  const w = await world(t);
  const { AdminService } = require('/app/dist/admin.service');
  const admin = new AdminService(w.I1.prisma, new KeycloakService(), null, w.I1.service);
  const caller = { roles: ['admin'], actor: 'syn-admin@synthetic.test', sub: 'syn-admin' };
  const fact = async sub => (await w.base.memberIsolation.findUnique({ where: { sub } })) ?? null;
  const sessionsOf = sub => w.base.authSession.count({ where: { sub } });

  for (const failing of ['sessions', 'disable']) {
    // (1) A code exchanged before the isolation (an SSO no product row knows) waits for its transaction; the member also
    // has a live product session. The provider fails one step of the isolation: the listing, or the disable.
    const m = 'syn-sub-u5e15-' + failing, P = 'syn-idp-u5e15-' + failing, L = P + '-live';
    kc.members[m] = { username: m, email: m + '@synthetic.test', enabled: true, groups: [A], roles: ['radiologist'], sessions: [P, L] };
    const live = await w.session(await w.issue('u5e15-live-' + failing, { sub: m, groups: [A], idp: L }));
    const begin = await w.call(w.I2, 'login');
    const gate = w.gate('I2', 'tx.open');
    const held = answerFlow(w, w.I2, begin, await w.issue('u5e15-' + failing, { sub: m, groups: [A], idp: P }));
    await gate.arrived();
    // The listing is answered 503 (a read: nothing to settle); the disable does not connect (never sent - a 503 to a change
    // would leave it unknown, and an unknown disable is never finished by anyone: U5E-27).
    if (failing === 'sessions') kc.adminFail = { sessions: 99 }; else kc.adminRefuse = { disable: 99 };
    const calls = kc.adminCalls.length;
    await assert.rejects(admin.patchUser(m, { enabled: false }, caller), error => error?.response?.code === 'USER_ISOLATED' || /USER_ISOLATED/.test(JSON.stringify(error?.response ?? '')),
      failing + ': the isolation reports that it did not finish');
    // Our fact was written before any provider call, and its provider work is owed.
    const owed = await fact(m);
    assert.deepEqual([!!owed, owed?.providerDoneAt ?? null], [true, null], failing + ': the fact is recorded, provider work owed');
    assert.ok(kc.adminCalls.slice(calls).includes('GET sessions'), failing + ': the provider work started after the fact');
    // The member's existing session ended at once (our own data; no provider answer needed), with cause isolation.
    assert.deepEqual([await w.version(live), (await w.marks()).find(x => x[0] === L)?.slice(0, 2)], [null, [L, 'isolation']]);
    // (2) The code exchanged before the isolation resumes: no session. With the listing failed nothing marked its
    // provider session and the provider's state is not read - our fact refuses it (member_isolated); with the disable
    // failed the listing had already marked it (idp_session_ended).
    gate.release();
    const late = await held;
    assert.deepEqual([late.newSid, late.proof, await sessionsOf(m), rowsOf(await w.rows(), m).filter(r => r.action === 'auth.login').at(-1).detail.cause],
      [null, undefined, 0, failing === 'sessions' ? 'member_isolated' : 'idp_session_ended'], failing + ': the earlier code passes no more');
    // Even with the admin API out entirely, the same: the login path does not depend on it.
    kc.adminDown = true;
    const before = kc.adminCalls.length;
    const again = await login(w, w.I1, await w.issue('u5e15-again-' + failing, { sub: m, groups: [A], idp: P + '-2' }));
    assert.deepEqual([again.done.newSid, kc.adminCalls.length - before], [null, 0], failing + ': refused without asking the admin API');
    kc.adminDown = false;
    // (3) A re-activation while the provider work is owed and still failing: it does not remove the fact - it must
    // finish the owed provider work first - so the member stays refused.
    await assert.rejects(admin.patchUser(m, { enabled: true }, caller), undefined, failing + ': Activate over unfinished provider work fails');
    assert.ok(await fact(m), failing + ': the fact stays after a failed re-activation');
    // (4) The provider recovers; the end retry cycle finishes the provider work from the fact (no admin action): every
    // provider session listed is marked and ended by its own id, the member is disabled, the fact says done - and stays.
    kc.adminFail = {};
    kc.adminRefuse = {};
    const restarted = w.instance('R-' + failing);
    restarted.service.onModuleInit();
    try {
      await w.until(failing + ': the owed provider work finished', async () => (await fact(m))?.providerDoneAt != null);
    } finally {
      restarted.service.onModuleDestroy();
    }
    await w.told();
    assert.deepEqual([kc.members[m].enabled, kc.userLogouts.includes(m), [P, L].filter(sid => kc.ended.includes(sid)),
      (await w.marks()).filter(x => x[0] === P || x[0] === L)],
      [false, false, [P, L], [[P, 'isolation', true], [L, 'isolation', true]]], failing + ': provider work done from the fact');
    // (5) A finished re-activation removes the fact; the provider session the isolation listed stays closed, a new login enters.
    assert.equal((await admin.patchUser(m, { enabled: true }, caller)).enabled, true);
    assert.equal(await fact(m), null, failing + ': only a finished re-activation removes the fact');
    const old = await login(w, w.I2, await w.issue('u5e15-old-' + failing, { sub: m, groups: [A], idp: P }));
    assert.equal(old.done.newSid, null, failing + ': the listed provider session stays closed after the re-activation');
    const fresh = await login(w, w.I2, await w.issue('u5e15-new-' + failing, { sub: m, groups: [A], idp: P + '-new' }));
    assert.deepEqual([fresh.done.cookie, !!fresh.done.proof], ['S', true], failing + ': a new login enters again');
  }
  // (6) Opposite side: another member is untouched by all of this, and its refresh never reads provider state.
  const o = 'syn-sub-u5e15-other';
  const ov = await w.issue('u5e15-other-next', { sub: o, groups: [A] });
  const oldOther = await w.session(await w.issue('u5e15-other', { sub: o, groups: [A] }), { atExpiresAt: lapsed() });
  kc.auto = () => reply.tokens(ov);
  kc.adminDown = true;
  const calls = kc.adminCalls.length;
  assert.deepEqual([(await w.call(w.I1, 'get', { sid: oldOther })).status, kc.adminCalls.length - calls], [200, 0]);
  kc.adminDown = false;
  kc.auto = null;
  await w.finish('U5E-15');
});

// Integration review F01 (R2-F02): "a probe never makes a session" holds for every probe of a flow, not only its first.
// A probe is asked again after an answer that did not identify the SSO (interaction_required), and a probe flow that
// expired before its callback is started again as a probe - both with restarts 1. If such a retried probe is answered
// with a code of the previous doctor's still-live SSO and were handled as a login, the next person would hold the previous
// doctor's product session without typing anything.
test('U5E-16 a retried probe (after interaction_required, or restarted from an expired own flow) answered with the previous doctor\'s SSO code makes no session: that SSO and its product session end, then the form', async t => {
  const w = await world(t);
  // (1) Shared PC, untrusted storage, product cookie gone; doctor A's SSO X is alive and A's product session S1 of it too.
  const s = 'syn-sub-u5e16', X = idpOf(s);
  const s1 = await w.session(await w.issue('u5e16-a', { sub: s, groups: [A] }));
  const begin = await w.call(w.I1, 'switch', { body: UNTRUSTED });
  assert.deepEqual([begin.status, promptOf(begin)], [200, 'none']);
  // The first probe is answered with interaction_required: asked once more, nothing recorded.
  const rows = (await w.rows()).length;
  const retried = await refuseFlow(w, w.I1, begin, 'interaction_required');
  assert.deepEqual([retried.status, atProvider(retried), promptOf(retried), retried.newSid, (await w.rows()).length],
    [302, true, 'none', null, rows], 'the probe is asked again');
  // The retried probe gets a code of A's SSO: still a probe - no session, no proof; X and S1 are ended, then the form.
  const probed = await answerFlow(w, w.I1, retried, await w.issue('u5e16-a2', { sub: s, groups: [A] }));
  assert.deepEqual([probed.status, atProvider(probed), promptOf(probed), probed.newSid, probed.proof, await w.sessions(), await w.version(s1)],
    [302, true, 'login', null, undefined, 0, null], 'a retried probe makes no session; the next step asks for credentials');
  assert.deepEqual([await w.marks(), kc.ended], [[[X, 'reauthentication', true]], [X]], 'the SSO is marked reauthentication and ended');
  const ended = rowsOf(await w.rows(), s);
  assert.deepEqual([summary(ended), ended[0].detail.trigger], [[['auth.logout', 'reauthentication', A]], 'storage_untrusted'],
    'A\'s product session of that SSO ended with its record; no login row');
  // Only credentials typed at that fresh step enter (here the next person B).
  const b = 'syn-sub-u5e16-b';
  const fresh = await answerFlow(w, w.I1, probed, await w.issue('u5e16-b', { sub: b, groups: [B] }));
  assert.deepEqual([fresh.cookie, !!fresh.proof, summary(rowsOf(await w.rows(), b))], ['S', true, [['auth.login', 'success', B]]]);

  // (2) The probe flow expired before its callback came back (the person left the browser at the provider): the callback
  // starts it again as a probe (restarts 1), its code unused. That restarted probe is answered by doctor C's live SSO Z.
  const c = 'syn-sub-u5e16-c', Z = idpOf(c);
  const c1 = await w.session(await w.issue('u5e16-c', { sub: c, groups: [A] }));
  const begin2 = await w.call(w.I2, 'switch', { body: UNREADABLE });
  assert.deepEqual([begin2.status, promptOf(begin2)], [200, 'none']);
  w.tick(31 * 60_000);
  const exchanged = kc.tokens;
  const restarted = await answerFlow(w, w.I2, begin2, await w.issue('u5e16-c-old', { sub: c, groups: [A] }));
  assert.deepEqual([restarted.status, atProvider(restarted), promptOf(restarted), restarted.newSid, kc.tokens - exchanged],
    [302, true, 'none', null, 0], 'the expired own flow is started again as the probe, its code unused');
  const live = await w.sessions();
  const probed2 = await answerFlow(w, w.I2, restarted, await w.issue('u5e16-c2', { sub: c, groups: [A] }));
  assert.deepEqual([probed2.status, atProvider(probed2), promptOf(probed2), probed2.newSid, probed2.proof, await w.sessions(), await w.version(c1)],
    [302, true, 'login', null, undefined, live - 1, null], 'the restarted probe makes no session; C\'s session of that SSO ends');
  assert.deepEqual([(await w.marks()).find(m => m[0] === Z), kc.ended.includes(Z)], [[Z, 'reauthentication', true], true]);
  const endedC = rowsOf(await w.rows(), c);
  assert.deepEqual([summary(endedC), endedC[0].detail.trigger], [[['auth.logout', 'reauthentication', A]], 'record_unreadable']);
  await w.finish('U5E-16');
});

/**
 * Waits (real time) until the provider and the database have been quiet for a moment: no new member-administration
 * call, provider end request or store access for 400 ms (bounded 8 s). A retry cycle has no answer to wait for.
 */
async function quiet(w) {
  const until = performance.now() + 8_000;
  let last = '', since = performance.now();
  while (performance.now() < until) {
    const now = [kc.adminCalls.length, idp.started, idp.open, w.calls.length].join();
    if (now !== last) { last = now; since = performance.now(); }
    else if (idp.open === 0 && performance.now() - since >= 400) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('harness: the provider and the store did not become quiet within 8 s');
}

// Integration review F04 (a) and F03: the isolation's second step (ending the member's product sessions - our own data,
// no provider needed) fails, and the provider's session listing keeps failing. The retry cycle must still end the
// member's surviving product session and disable the member at the provider - not leave that session working until its
// access token's expiry, nor the member enabled, because the listing failed first. A provider session no product row knows
// (another PC's SSO) is found only by a listing: it is marked and ended by its own id once a listing names it (there is no
// whole-user logout, S7-U5 D600); the fact stays owed (no providerDoneAt without a successful listing). Once the listing
// answers, the next cycle marks and ends that provider session and finishes.
// On the in-memory stand-in (tmp/.../local-svc) the store fault and the cycle run the same way, so these assertions are
// not vacuous there; what the stand-in does not model is PostgreSQL's locking (advisory locks, lock_timeout), which this
// case does not rely on.
test('U5E-17 a failed second isolation step and a failing provider listing: the retry cycle still ends the member\'s surviving session and disables the member; the fact stays owed until a listing lets it mark and end the other provider session', async t => {
  const w = await world(t);
  const { AdminService } = require('/app/dist/admin.service');
  const admin = new AdminService(w.I1.prisma, new KeycloakService(), null, w.I1.service);
  const caller = { roles: ['admin'], actor: 'syn-admin@synthetic.test', sub: 'syn-admin' };
  const m = 'syn-sub-u5e17', L = 'syn-idp-u5e17-live', P = 'syn-idp-u5e17-other-pc';
  kc.members[m] = { username: m, email: m + '@synthetic.test', enabled: true, groups: [A], roles: ['radiologist'], sessions: [L, P] };
  const live = await w.session(await w.issue('u5e17-live', { sub: m, groups: [A], idp: L }));
  // Step 2 (the read of the member's product sessions) fails once; the provider's listing fails throughout.
  w.fault('I1', 'sweepRead', new Error('syn: the store failed'));
  kc.adminFail = { sessions: 99 };
  await assert.rejects(admin.patchUser(m, { enabled: false }, caller),
    error => /USER_ISOLATED/.test(JSON.stringify(error?.response ?? error?.message ?? '')), 'the isolation reports that it did not finish');
  const fact = await w.base.memberIsolation.findUnique({ where: { sub: m } });
  assert.deepEqual([!!fact, fact?.providerDoneAt ?? null], [true, null], 'the fact is recorded, its provider work owed');
  // One retry cycle (a process start resumes every owed isolation), the listing still failing.
  const cycle = w.instance('C17');
  cycle.service.onModuleInit();
  try { await quiet(w); } finally { cycle.service.onModuleDestroy(); }
  await w.told();
  // The surviving product session is ended (cause isolation) and refused - it does not keep working until atExpiresAt.
  const used = await w.call(w.I1, 'get', { sid: live });
  assert.deepEqual([await w.version(live), used.status, await endsOf(w, m)], [null, 401, [['auth.logout', 'isolation', A]]],
    'the member\'s surviving session is ended by the cycle and refused');
  // What needs no listing is done anyway: the member is disabled at the provider, and the provider session of the ended
  // product row is ended by its id. The other PC's provider session is not known without a listing: neither marked nor ended.
  assert.deepEqual([kc.members[m].enabled, kc.ended.includes(L), kc.ended.includes(P), (await w.marks()).map(x => x[0]), kc.userLogouts],
    [false, true, false, [L], []], 'disabled and the known provider session ended without the listing; the unlisted one waits for it');
  // No listing succeeded: the provider work stays owed.
  assert.equal((await w.base.memberIsolation.findUnique({ where: { sub: m } }))?.providerDoneAt ?? null, null, 'still owed');
  // The listing answers again: the next cycle marks the other PC's provider session, ends it by its id and finishes.
  kc.adminFail = {};
  const next = w.instance('C17b');
  next.service.onModuleInit();
  try {
    await w.until('the owed provider work finished', async () =>
      (await w.base.memberIsolation.findUnique({ where: { sub: m } }))?.providerDoneAt != null);
  } finally {
    next.service.onModuleDestroy();
  }
  await w.told();
  // (Each listing that still names it asks again - a repeat is answered 404 and is done as well.)
  const asked = await w.changes(P);
  assert.deepEqual([kc.ended.includes(P), (await w.marks()).filter(x => x[0] === P), kc.userLogouts, asked.length > 0 && asked.every(state => state === 'done')],
    [true, [[P, 'isolation', true]], [], true], 'listed, marked and ended by its own id, confirmed by the requests\' own answers');
  await w.finish('U5E-17');
});

// Integration review F04 (b): an administrator's Activate runs while the retry cycle is inside the isolation's provider
// work (held after it listed the member's provider sessions). The re-activation finishes the owed work itself, enables
// the member and clears the fact; the member logs in again. The cycle, when it goes on, must not disable the member,
// log the member out or end the new session after that Activate.
// On the stand-in the hold is the harness gate on the cycle's store transaction (not a lock), so the order is the same
// on both; the assertion is not vacuous there.
test('U5E-18 an Activate during the isolation retry cycle: the cycle does not disable, log out or end the member after the enable', async t => {
  const w = await world(t);
  const { AdminService } = require('/app/dist/admin.service');
  const admin = new AdminService(w.I1.prisma, new KeycloakService(), null, w.I1.service);
  const caller = { roles: ['admin'], actor: 'syn-admin@synthetic.test', sub: 'syn-admin' };
  const m = 'syn-sub-u5e18', P = 'syn-idp-u5e18-p';
  kc.members[m] = { username: m, email: m + '@synthetic.test', enabled: true, groups: [A], roles: ['radiologist'], sessions: [P] };
  // The isolation's listing fails: the fact stays owed for the cycle.
  kc.adminFail = { sessions: 99 };
  await assert.rejects(admin.patchUser(m, { enabled: false }, caller), undefined, 'the isolation did not finish');
  kc.adminFail = {};
  // The cycle takes the owed work over (its first store transaction), lists the member's provider sessions and is held at its
  // next store transaction (marking what the listing named; its disable is still to come).
  const cycle = w.instance('C18');
  const taken = w.gate('C18', 'tx.open'), gate = w.gate('C18', 'tx.open');
  cycle.service.onModuleInit();
  try {
    await taken.arrived();
    taken.release();
    await gate.arrived();
    // Activate meanwhile: the owed work is finished by the re-activation itself, the member enabled, the fact cleared.
    assert.equal((await admin.patchUser(m, { enabled: true }, caller)).enabled, true);
    assert.equal(await w.base.memberIsolation.count({ where: { sub: m } }), 0, 'the finished re-activation cleared the fact');
    // The member logs in again (a new provider session, credentials entered).
    const P2 = 'syn-idp-u5e18-p2';
    kc.members[m].sessions = [P2];
    const again = await login(w, w.I2, await w.issue('u5e18-again', { sub: m, groups: [A], idp: P2 }));
    assert.equal(again.done.cookie, 'S', 'the active member enters');
    const calls = kc.adminCalls.length;
    gate.release();
    await quiet(w);
    await w.told();
    // The cycle went on after the Activate: it disabled nobody, logged nobody out and ended nothing of the active member.
    const after = kc.adminCalls.slice(calls);
    assert.deepEqual([kc.members[m].enabled, after.filter(c => c === 'PUT disable' || c === 'POST logout'),
      await w.base.authSession.count({ where: { sub: m } }), kc.ended.includes(P2)], [true, [], 1, false],
      'the re-activated member stays enabled with its new session');
  } finally {
    taken.release();
    gate.release();
    cycle.service.onModuleDestroy();
  }
  // The same, with the re-activation still in progress when the cycle goes on (the fact not cleared yet): the
  // re-activation has taken the owed work over, so the older cycle stops at its next step - it does not disable or log
  // out the member in the middle of the Activate.
  const m2 = 'syn-sub-u5e18-b', Q = 'syn-idp-u5e18-q';
  kc.members[m2] = { username: m2, email: m2 + '@synthetic.test', enabled: true, groups: [A], roles: ['radiologist'], sessions: [Q] };
  kc.adminFail = { sessions: 99 };
  await assert.rejects(admin.patchUser(m2, { enabled: false }, caller), undefined, 'the isolation did not finish');
  kc.adminFail = {};
  // The older cycle has taken the owed work over and listed; the Activate takes it over in turn (its first store transaction)
  // and is held at its next one.
  const older = w.instance('C18b');
  const oldTaken = w.gate('C18b', 'tx.open'), held = w.gate('C18b', 'tx.open');
  older.service.onModuleInit();
  const activateHeld = w.pause({ inst: 'I1', model: '$transaction', phase: 'after' }, e => e.result?.epoch && !e.result?.sub);
  let activating = null;
  try {
    await oldTaken.arrived();
    oldTaken.release();
    await held.arrived();
    activating = admin.patchUser(m2, { enabled: true }, caller);
    await activateHeld.arrived();
    const calls = kc.adminCalls.length;
    held.release();
    await quiet(w);
    assert.deepEqual(kc.adminCalls.slice(calls).filter(c => c === 'PUT disable' || c === 'POST logout'), [],
      'the older cycle stopped: the re-activation holds the owed work');
  } finally {
    oldTaken.release();
    held.release();
    activateHeld.release();
    older.service.onModuleDestroy();
  }
  assert.equal((await activating).enabled, true);
  assert.deepEqual([kc.members[m2].enabled, await w.base.memberIsolation.count({ where: { sub: m2 } })], [true, 0]);
  await w.finish('U5E-18');
});

// Review of 8c2cf37 (F-04): the cycle asks whether it still holds the owed work immediately before each provider call (and
// before each product session it ends, which tells the provider), so an Activate that lands in between stops it - it asks
// the provider nothing more (not even a listing) and ends nothing. Two places:
//   a. the cycle is reading the member's product sessions (its first step, just before its first listing) when the
//      Activate lands; the cycle goes on before the member logs in again: it does not list;
//   a2. the same, but the member has logged in again when the cycle goes on: what the cycle read is the new session, and
//      the cycle does not end it.
// (An Activate that lands while one of the cycle's provider calls is in flight waits for that call: U5E-20.)
// The Activate finishes the owed work itself, enables the member and clears the fact. On the stand-in the hold is the
// harness gate on the cycle's store read, not a lock, so the order is the same on both.
test('U5E-19 an Activate that lands between the isolation retry cycle\'s provider calls stops the cycle: the member ends enabled, the fact cleared, nothing asked or ended after it', async t => {
  const w = await world(t);
  const { AdminService } = require('/app/dist/admin.service');
  const admin = new AdminService(w.I1.prisma, new KeycloakService(), null, w.I1.service);
  const caller = { roles: ['admin'], actor: 'syn-admin@synthetic.test', sub: 'syn-admin' };
  for (const tag of ['a', 'a2']) {
    const at = { a: 'before the first listing', a2: 'before the first listing, logged in again' }[tag];
    const m = 'syn-sub-u5e19' + tag, P = 'syn-idp-u5e19-' + tag, P2 = P + '-again';
    kc.members[m] = { username: m, email: m + '@synthetic.test', enabled: true, groups: [A], roles: ['radiologist'], sessions: [P] };
    kc.adminFail = { sessions: 99 };
    await assert.rejects(admin.patchUser(m, { enabled: false }, caller), undefined, at + ': the isolation did not finish');
    kc.adminFail = {};
    const cycle = w.instance('C19' + tag);
    const { arrived, release } = w.gate('C19' + tag, 'sweepRead');
    cycle.service.onModuleInit();
    try {
      await arrived();
      assert.equal(kc.members[m].enabled, false, at + ': the member is disabled at the provider');
      assert.equal((await admin.patchUser(m, { enabled: true }, caller)).enabled, true);
      assert.equal(await w.base.memberIsolation.count({ where: { sub: m } }), 0, at + ': the finished re-activation cleared the fact');
      const relogin = tag !== 'a';
      if (relogin) {
        kc.members[m].sessions = [P2];
        const again = await login(w, w.I2, await w.issue('u5e19-again-' + tag, { sub: m, groups: [A], idp: P2 }));
        assert.equal(again.done.cookie, 'S', at + ': the active member enters');
      }
      const calls = kc.adminCalls.length;
      release();
      await quiet(w);
      await w.told();
      assert.deepEqual([kc.adminCalls.slice(calls), kc.members[m].enabled, await w.base.memberIsolation.count({ where: { sub: m } }),
        await w.base.authSession.count({ where: { sub: m } }), kc.ended.includes(P2)], [[], true, 0, relogin ? 1 : 0, false],
        at + ': the cycle stopped - no provider call after the Activate, the member enabled (with its new session)');
    } finally {
      release();
      cycle.service.onModuleDestroy();
    }
  }
  await w.finish('U5E-19');
});

// ── S7-U5 D600 (Astra consultation, fix round 6): every change call to the provider is recorded before it is sent and only
// its own answer settles it; an Activate answers within 15 s and succeeds only when no change of the member is unknown ──

const ACTIVATION_SENTENCE = '활성화를 확인하지 못했습니다. 이용 제한을 유지합니다. 5초 뒤 다시 시도하세요.';
const UNCONFIRMED = [409, 'ACTIVATION_UNCONFIRMED', 5, ACTIVATION_SENTENCE];
const unconfirmedOf = result => [result.status, result.body?.code ?? null, result.body?.retryAfterSeconds ?? null, result.body?.message ?? null];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * An administrator's Activate started now. `result` is what the controller answers: {status: 200, user} or the HTTP
 * exception's {status, body}; `took` its real duration (the 15 s bound is the product's monotonic clock, not the mocked Date).
 */
function activation(admin, m, caller) {
  const run = { settled: false, took: null };
  const from = performance.now();
  run.result = admin.patchUser(m, { enabled: true }, caller)
    .then(user => ({ status: 200, user }), error => ({
      status: typeof error?.getStatus === 'function' ? error.getStatus() : 500,
      body: typeof error?.getResponse === 'function' ? error.getResponse() : { message: String(error) } }))
    .finally(() => { run.settled = true; run.took = performance.now() - from; });
  return run;
}

/**
 * Holds the next member-administration request `call` ('PUT disable', 'PUT enable', ...) of `member` (any, when not
 * given): before the provider carries it out ('before'), or its answer after it was carried out ('after'). `release(how)`
 * lets it go ('drop' / '500' instead, see the fake). Holds of one world chain; each takes one request.
 */
function holdAdmin(call, when, member) {
  const slot = when === 'before' ? 'beforeAdmin' : 'onAdmin';
  const held = { arrived: deferred(), release: deferred(), taken: false };
  const previous = kc[slot];
  kc[slot] = (name, id) => {
    if (held.taken || name !== call || (member && id !== member)) return previous ? previous(name, id) : undefined;
    held.taken = true;
    held.arrived.resolve();
    return held.release.promise;
  };
  return { arrived: () => within(held.arrived.promise, `${call} of ${member ?? 'a member'} reaching the provider`),
    release: how => held.release.resolve(how) };
}

/** The same for the next end request (DELETE sessions/{sid}) of one provider session. */
function holdEnd(sid, when) {
  const slot = when === 'before' ? 'beforeEnd' : 'afterEnd';
  const held = { arrived: deferred(), release: deferred(), taken: false };
  const previous = kc[slot];
  kc[slot] = id => {
    if (held.taken || id !== sid) return previous ? previous(id) : undefined;
    held.taken = true;
    held.arrived.resolve();
    return held.release.promise;
  };
  return { arrived: () => within(held.arrived.promise, `the end of ${sid} reaching the provider`), release: how => held.release.resolve(how) };
}

/**
 * A member whose isolation leaves its provider work owed (the listing fails; when `disable` is false the disable does not
 * connect either - never sent, so nothing of it is unknown).
 */
async function owedIsolation(admin, caller, m, P, { disable = true } = {}) {
  kc.members[m] = { username: m, email: m + '@synthetic.test', enabled: true, groups: [A], roles: ['radiologist'], sessions: [P] };
  kc.adminFail = { sessions: 99 };
  kc.adminRefuse = disable ? {} : { disable: 1 };
  await assert.rejects(admin.patchUser(m, { enabled: false }, caller), undefined, m + ': the isolation did not finish');
  kc.adminFail = {};
  kc.adminRefuse = {};
}

// Final review part 1, blocker 1, as replaced by S7-U5 D600: an Activate that lands while one of the isolation retry cycle's
// provider calls is in flight must not be undone by that call. The re-activation takes the owed work over and waits - within
// its 15 s - until every change call of the member has its own answer (never a lease or a time: the earlier contract "goes
// on once the call's bound has passed" is withdrawn). Places:
//   a. the cycle's disable is in flight - not carried out yet (it lands when the case lets it), or carried out with its
//      answer on its way: the Activate waits for that answer; the member ends enabled, the fact cleared, no disable after the
//      enable;
//   e. (inside a) a login while the Activate waits is not delayed: the isolated member's is refused at once, another
//      member's enters;
//   b. the cycle's end of one of the member's provider sessions is in flight: the Activate waits for that request's own
//      answer; the provider session the member makes after the Activate is not ended (there is no whole-user logout);
//   f. the cycle has passed its last check before its disable when the Activate takes the owed work over: the cycle asks
//      the provider nothing more (its change cannot be recorded under work that is no longer its own);
//   d. opposite side: without an Activate the cycle finishes the owed work as before and leaves no change unknown - the
//      next isolation and Activate of the member go through at once;
//   c. the side that recorded its disable died before the call came back (its record is all that is left, nobody will
//      receive its answer): a minute later, from a restarted process, the Activate answers 409 ACTIVATION_UNCONFIRMED within
//      15 s with the isolation kept and nothing of its own sent.
// What a case holds is the fake provider's request (beforeAdmin / onAdmin / beforeEnd) or the harness gate on a store read,
// not a lock, so the order is the same on the stand-in and on PostgreSQL; the waiting itself is the product's on both.
test('U5E-20 an Activate that lands while the isolation retry cycle\'s provider call is in flight waits for that call\'s own answer: the member ends enabled, its new provider session is not ended, logins are not delayed; a call whose sender died is never settled by time', async t => {
  const w = await world(t);
  const { AdminService } = require('/app/dist/admin.service');
  const admin = new AdminService(w.I1.prisma, new KeycloakService(), null, w.I1.service);
  const caller = { roles: ['admin'], actor: 'syn-admin@synthetic.test', sub: 'syn-admin' };
  const facts = sub => w.base.memberIsolation.count({ where: { sub } });
  // What reached the provider after the last enable that would undo it (a whole-user logout never comes at all).
  const undoing = () => kc.adminCalls.slice(kc.adminCalls.lastIndexOf('PUT enable') + 1).filter(c => c === 'PUT disable' || c === 'POST logout');
  const own = c => ['GET sessions', 'PUT disable', 'POST logout', 'PUT enable'].includes(c);

  // (a) + (e)
  for (const when of ['before', 'after']) {
    const at = 'a, the disable ' + (when === 'before' ? 'not carried out yet' : 'carried out, its answer on its way');
    const m = 'syn-sub-u5e20a-' + when, P = 'syn-idp-u5e20a-' + when;
    await owedIsolation(admin, caller, m, P);
    assert.equal(kc.members[m].enabled, false, m + ': disabled at the provider, the fact owed');
    const disable = holdAdmin('PUT disable', when, m);
    const cycle = w.instance('C20a-' + when);
    cycle.service.onModuleInit();
    try {
      await disable.arrived();
      const run = activation(admin, m, caller);
      if (when === 'before') {
        // (e) Meanwhile the isolated member tries to log in: refused at once, from our own fact; another member enters.
        const refused = await within(login(w, w.I2, await w.issue('u5e20-during', { sub: m, groups: [A], idp: P + '-during' })),
          'the isolated member\'s login while the Activate waits', 5000);
        assert.deepEqual([refused.done.newSid, rowsOf(await w.rows(), m).filter(r => r.action === 'auth.login').at(-1).detail.cause],
          [null, 'member_isolated'], 'e: the isolated member\'s login is refused at once');
        const o = 'syn-sub-u5e20-other';
        const entered = await within(login(w, w.I2, await w.issue('u5e20-other', { sub: o, groups: [A] })),
          'another member\'s login while the Activate waits', 5000);
        assert.deepEqual([entered.done.cookie, !!entered.done.proof], ['S', true], 'e: another member\'s login enters');
      }
      await pause(600);
      const waited = !run.settled;
      disable.release();
      const result = await run.result;
      await quiet(w);
      await w.told();
      assert.deepEqual([result.status, result.user?.enabled, kc.members[m].enabled, await facts(m), undoing(),
        (await w.changes(m, 'disable')).every(state => state === 'done')],
        [200, true, true, 0, [], true], at + ': the member ends enabled, the fact cleared, nothing after the enable undoes it, every disable answered');
      assert.equal(waited, true, at + ': the Activate waited for the cycle\'s call to have its own answer');
    } finally {
      disable.release();
      cycle.service.onModuleDestroy();
    }
  }

  // (b)
  {
    const m = 'syn-sub-u5e20b', P = 'syn-idp-u5e20b', P2 = P + '-again';
    await owedIsolation(admin, caller, m, P);
    const end = holdEnd(P, 'before');
    const cycle = w.instance('C20b');
    cycle.service.onModuleInit();
    try {
      await end.arrived();
      const run = activation(admin, m, caller);
      await pause(600);
      const waited = !run.settled;
      end.release();
      const result = await run.result;
      assert.deepEqual([result.status, waited], [200, true], 'b: the Activate waited for the end request\'s own answer');
      // The member logs in again after the Activate (a new provider session, credentials typed).
      kc.members[m].sessions = [P2];
      const again = await login(w, w.I2, await w.issue('u5e20b-again', { sub: m, groups: [A], idp: P2 }));
      assert.equal(again.done.cookie, 'S', 'b: the active member enters');
      await quiet(w);
      await w.told();
      assert.deepEqual([kc.ended.includes(P2), await w.base.authSession.count({ where: { sub: m } }), kc.members[m].enabled, await facts(m),
        undoing(), kc.userLogouts], [false, 1, true, 0, [], []], 'b: the provider session made after the Activate is not ended; the member stays enabled');
    } finally {
      end.release();
      cycle.service.onModuleDestroy();
    }
  }

  // (f)
  {
    const m = 'syn-sub-u5e20f', P = 'syn-idp-u5e20f';
    await owedIsolation(admin, caller, m, P);
    const cycle = w.instance('C20f');
    // The cycle's two reads of the member's product sessions: before its first listing, and after it marked what that
    // listing named. Held at the second, its last check before the disable is behind it.
    const early = w.gate('C20f', 'sweepRead'), late = w.gate('C20f', 'sweepRead');
    const activating = w.pause({ inst: 'I1', model: '$transaction', phase: 'after' }, e => e.result?.epoch && !e.result?.sub);
    let run = null;
    cycle.service.onModuleInit();
    try {
      await early.arrived();
      early.release();
      await late.arrived();
      run = activation(admin, m, caller);
      // The Activate has taken the owed work over and is held at its own first read.
      await activating.arrived();
      const calls = kc.adminCalls.length;
      late.release();
      await quiet(w);
      assert.deepEqual(kc.adminCalls.slice(calls), [], 'f: the cycle that lost the owed work asks the provider nothing more');
    } finally {
      early.release();
      late.release();
      activating.release();
      cycle.service.onModuleDestroy();
    }
    assert.equal((await run.result).status, 200);
    await quiet(w);
    assert.deepEqual([kc.members[m].enabled, await facts(m), undoing()], [true, 0, []], 'f: the member ends enabled, the fact cleared');
  }

  // (d)
  {
    const m = 'syn-sub-u5e20d', P = 'syn-idp-u5e20d';
    await owedIsolation(admin, caller, m, P);
    const cycle = w.instance('C20d');
    cycle.service.onModuleInit();
    try {
      await w.until('d: the cycle finished the owed provider work', async () =>
        (await w.base.memberIsolation.findUnique({ where: { sub: m } }))?.providerDoneAt != null);
    } finally {
      cycle.service.onModuleDestroy();
    }
    await quiet(w);
    await w.told();
    assert.deepEqual([kc.members[m].enabled, kc.ended.includes(P), kc.userLogouts, (await w.marks()).filter(x => x[0] === P)],
      [false, true, [], [[P, 'isolation', true]]], 'd: the cycle marked, ended by its id and disabled as before');
    assert.equal(await w.base.providerChange.count({ where: { sub: m, state: 'unknown' } }), 0, 'd: no change of the member left unknown');
    assert.equal((await within(admin.patchUser(m, { enabled: false }, caller), 'd: the next isolation of the member', 5000)).enabled, false);
    assert.equal((await within(admin.patchUser(m, { enabled: true }, caller), 'd: the Activate after it', 5000)).enabled, true);
    assert.equal(await facts(m), 0);
  }

  // (c)
  {
    const m = 'syn-sub-u5e20c', P = 'syn-idp-u5e20c';
    await owedIsolation(admin, caller, m, P);
    // A side took the owed work over (its generation), recorded its disable and died before the call came back.
    const row = await w.base.memberIsolation.findUnique({ where: { sub: m } });
    await w.base.memberIsolation.update({ where: { sub: m }, data: { attempts: row.attempts + 1 } });
    await w.base.providerChange.create({ data: { kind: 'disable', target: m, sub: m, generation: row.attempts + 1, state: 'unknown', createdAt: new Date() } });
    // A minute passes and the Activate comes to a process that never saw that call.
    w.tick(60_000);
    const restarted = w.instance('R20c');
    const otherAdmin = new AdminService(restarted.prisma, new KeycloakService(), null, restarted.service);
    const calls = kc.adminCalls.length;
    const run = activation(otherAdmin, m, caller);
    const result = await run.result;
    assert.deepEqual([...unconfirmedOf(result), run.took < 15_000], [...UNCONFIRMED, true],
      'c: the record of a call nobody will ever hear from keeps the Activate from succeeding; answered within 15 s');
    assert.deepEqual([kc.adminCalls.slice(calls).filter(own), await facts(m), await w.changes(m, 'disable'), kc.members[m].enabled],
      [[], 1, ['done', 'unknown'], false], 'c: nothing of its own was sent, the isolation kept, the record still unknown');
  }
  await w.finish('U5E-20');
});

// S7-U5 CE1 (S1 real-screen counterexample 1, candidate-diag-S1 ce1-diagnosis): Keycloak names an SSO by the browser's
// authentication-session id, so the next SSO of a browser that kept an unfinished login screen (a login tab closed, the
// app's address opened twice before logging in) gets the ENDED SSO's sid - the next person's SSO or the same doctor's. A mark
// covers the ended SSO's authentication (auth_time before the confirmed end), not the sid:
//   a. the previous doctor's barrier stays: a callback that exchanged its code before the Log out and resumes after the end
//      was confirmed makes no session (acceptance 1); a code authenticated in the very second of the confirmation, before
//      it, is refused too when its flow cannot prove a later start (no rounding down for a plain flow);
//   b. a new SSO with the SAME sid, authenticated after the confirmed end, enters with one credential entry: the next person
//      at the unfinished-logout landing in the second of the confirmation (the bound start's fresh step; measured 0.08 s
//      on the real stack), and the same doctor after an ordinary Log out (the probe's fresh step) - the mark stays as it
//      was and that new SSO is not ended;
//   c. a replay of the ended SSO's token or code after that is refused;
//   d. the Bearer path judges as the callback: the ended SSO's token refused, the new SSO's accepted, also when its
//      authentication shares the second of the confirmation (the authentication the callback admitted);
//   e. the edges: a fresh step started after the end counts from the second it started - one second earlier is refused, its
//      own second passes; a fresh step started before the end was confirmed counts from the confirmation; the same second
//      on the Bearer path without an admitted session (another person, a token without auth_time) is refused;
//   f. the new SSO ended in its turn: until that end is confirmed every authentication of the sid is refused (also a later
//      one), afterwards the new SSO's own authentication too - a newer one enters;
//   g. the keep window counts from the last confirmation, not from the first decision of a re-ended sid.
// The clock starts 400 ms into a second, so that "the second of the confirmation, before it" exists.
test('U5E-21 (S7-U5 CE1) a mark covers the ended SSO\'s authentication, not its sid: the browser\'s next SSO with the same sid enters, the ended SSO\'s code and token stay refused', async t => {
  const w = await world(t, { now: START + 400 });
  const sec = ms => Math.floor(ms / 1000);
  const ENDED = [401, 'AUTH_SESSION_ENDED', 'AUTH_SESSION_ENDED'];
  const bearer = async v => { const out = await w.call(w.I1, 'get', { bearer: v.access }); return out.status === 200 ? [200] : coded(out); };
  const confirmedAt = async idp => (await w.mark(idp))?.confirmedAt?.getTime() ?? null;

  // ── 1. the next person at the previous doctor's unfinished-logout landing (CE1 round 2, SE-03b) ──
  const a = 'syn-sub-u5e21-a', b = 'syn-sub-u5e21-b', X = 'syn-idp-u5e21-pc1';
  const aOld = await w.issue('u5e21-a', { sub: a, groups: [A], idp: X, authTime: sec(Date.now()) - 3600 });
  const s1 = await w.session(aOld);
  const start = await w.call(w.I1, 'switch', { sid: s1, body: UNFINISHED });
  assert.deepEqual([start.status, promptOf(start)], [200, 'login'], 'the bound start ended A and goes to the fresh step');
  assert.deepEqual(await bearer(aOld), ENDED, 'a: the ended SSO\'s token is refused once its end is confirmed');
  const end1 = await confirmedAt(X);
  assert.equal(end1 % 1000, 400, 'the end is confirmed 400 ms into a second');
  // B types credentials at once: the provider authenticates B in the second of the confirmation and names B's new SSO by
  // the browser's id - the ended SSO's sid.
  const asked1 = kc.endRequests.length;
  const bv = await w.issue('u5e21-b', { sub: b, groups: [B], idp: X, authTime: sec(end1) });
  const entered = await answerFlow(w, w.I1, start, bv);
  assert.deepEqual([entered.status, entered.cookie, !!entered.proof], [302, 'S', true], 'b: B enters with one credential entry');
  assert.deepEqual([(await w.base.authSession.findUnique({ where: { sid: entered.newSid } })).idpSid, summary(rowsOf(await w.rows(), b))],
    [X, [['auth.login', 'success', B]]], 'b: B\'s session is of the reused sid; no idp_session_ended refusal');
  assert.deepEqual([(await w.mark(X)).cause, await confirmedAt(X), kc.endRequests.length - asked1], ['logout', end1, 0],
    'b: the mark stays as it was and B\'s new SSO is not ended');
  // c + d: the Bearer path.
  assert.deepEqual(await bearer(aOld), ENDED, 'c/d: the ended SSO\'s token (authenticated an hour before the end) is refused');
  assert.deepEqual(await bearer(bv), [200], 'd: B\'s token - same sid, the second of the confirmation - is the authentication the callback admitted');
  const other = await w.issue('u5e21-other', { sub: 'syn-sub-u5e21-other', groups: [B], idp: X, authTime: sec(end1) });
  assert.deepEqual(await bearer(other), ENDED, 'e: the same second, nobody admitted with that authentication: covered');
  assert.deepEqual(await bearer(await w.issue('u5e21-b-untimed', { sub: b, groups: [B], idp: X })), ENDED, 'e: a token without auth_time: covered');
  w.tick(1000);
  const bLaterAuth = sec(Date.now());
  const bLater = await w.issue('u5e21-b-later', { sub: b, groups: [B], idp: X, authTime: bLaterAuth });
  assert.deepEqual(await bearer(bLater), [200], 'b/d: an authentication of a later second than the confirmed end needs no admitted session');

  // f. B's SSO ends in its turn; the provider does not confirm it yet.
  w.tick(1000);
  kc.logoutMode = 'refused';
  assert.equal((await w.call(w.I1, 'logout', { sid: entered.newSid })).status, 204);
  await w.told();
  assert.deepEqual([(await w.mark(X)).cause, await confirmedAt(X)], ['logout', null], 'f: the same mark, unconfirmed again; the first cause stays');
  assert.deepEqual([await bearer(bv), await bearer(bLater)], [ENDED, ENDED], 'f: unconfirmed: every authentication of the sid is covered');
  const during = await w.call(w.I2, 'login');
  const refusedDuring = await answerFlow(w, w.I2, during, await w.issue('u5e21-during', { sub: b, groups: [B], idp: X, authTime: sec(Date.now()) }));
  assert.deepEqual([refusedDuring.location, refusedDuring.newSid], [landing('end_unconfirmed'), null], 'f: a code of this second, while unconfirmed: no session');
  kc.logoutMode = 'ok';
  w.tick(1000);
  const resumer = w.instance('R21');
  resumer.service.onModuleInit();
  try {
    await w.until('the re-ended SSO confirmed', async () => (await confirmedAt(X)) !== null);
  } finally {
    resumer.service.onModuleDestroy();
  }
  const end2 = await confirmedAt(X);
  assert.ok(end2 > end1 && sec(end2) > bLaterAuth, 'f: confirmed later, in a later second than B\'s authentications');
  assert.deepEqual(await bearer(bLater), ENDED, 'f: B\'s own authentication is now before a confirmed end');
  w.tick(1000);
  const newer = await login(w, w.I2, await w.issue('u5e21-newer', { sub: b, groups: [B], idp: X, authTime: sec(Date.now()) }));
  assert.deepEqual([newer.done.cookie, !!newer.done.proof], ['S', true], 'f: a newer authentication after that end enters');

  // ── 2. the previous doctor's barrier, and the same doctor after an ordinary Log out (X6, SE-03c) ──
  const c = 'syn-sub-u5e21-c', Y = 'syn-idp-u5e21-pc2';
  const cOld = await w.issue('u5e21-c', { sub: c, groups: [A], idp: Y, authTime: sec(Date.now()) - 600 });
  const s2 = await w.session(cOld);
  // a. C's second tab: the provider answered without a form, the code is exchanged, the callback held before its transaction.
  const tab2 = await w.call(w.I2, 'login');
  const gate = w.gate('I2', 'tx.open');
  const heldC = answerFlow(w, w.I2, tab2, await w.issue('u5e21-c-tab2', { sub: c, groups: [A], idp: Y, authTime: sec(Date.now()) - 600 }));
  await gate.arrived();
  assert.equal((await w.call(w.I1, 'logout', { sid: s2 })).status, 204);
  await w.told();
  gate.release();
  const resumed = await heldC;
  assert.deepEqual([resumed.newSid, resumed.cookie, atProvider(resumed), await w.base.authSession.count({ where: { sub: c } })], [null, 'P', true, 0],
    'a: the callback that exchanged before the end makes no session once the end is confirmed');
  const endY = await confirmedAt(Y);
  assert.equal(endY % 1000, 400, 'the ordinary Log out\'s end was confirmed 400 ms into a second');
  const sameSecond = await w.call(w.I2, 'login');
  const refusedSame = await answerFlow(w, w.I2, sameSecond, await w.issue('u5e21-c-same', { sub: c, groups: [A], idp: Y, authTime: sec(endY) }));
  assert.deepEqual([refusedSame.newSid, atProvider(refusedSame)], [null, true],
    'a/e: authenticated in the second of the confirmation, by a flow that proves no later start: covered (no rounding down)');
  assert.deepEqual(summary(rowsOf(await w.rows(), c)),
    [['auth.login', 'idp_session_ended', A], ['auth.login', 'idp_session_ended', A], ['auth.logout', 'logout', A]]);
  assert.deepEqual(await bearer(cOld), ENDED, 'c: the replayed token of the ended SSO is refused');
  // b. the same doctor comes back three seconds later: Login, the probe finds no SSO, the fresh step, C's credentials -
  // and Keycloak hands C's new SSO the ended sid.
  w.tick(3000);
  const back = await w.call(w.I1, 'switch', { body: UNFINISHED });
  const fresh = await refuseFlow(w, w.I1, back, 'login_required');
  assert.deepEqual([promptOf(back), promptOf(fresh)], ['none', 'login']);
  const asked2 = kc.endRequests.length;
  const cBack = await answerFlow(w, w.I1, fresh, await w.issue('u5e21-c-back', { sub: c, groups: [A], idp: Y, authTime: sec(Date.now()) }));
  assert.deepEqual([cBack.cookie, !!cBack.proof, kc.endRequests.length - asked2, (await w.mark(Y)).confirmedAt !== null], ['S', true, 0, true],
    'b: the same doctor enters with one credential entry; the new SSO is not ended, the mark stays');

  // ── 3. the fresh step's own edges (doctor D) ──
  const d = 'syn-sub-u5e21-d', Z = 'syn-idp-u5e21-pc3';
  const s3 = await w.session(await w.issue('u5e21-d', { sub: d, groups: [A], idp: Z, authTime: sec(Date.now()) - 600 }));
  // Two fresh steps started BEFORE the end (another tab's recovery Login), then D's Log out ends Z 300 ms later.
  const early = [];
  while (early.length < 2) early.push(await refuseFlow(w, w.I1, await w.call(w.I1, 'switch', { body: UNTRUSTED }), 'login_required'));
  w.tick(300);
  assert.equal((await w.call(w.I1, 'logout', { sid: s3 })).status, 204);
  await w.told();
  const endZ = await confirmedAt(Z);
  assert.ok(endZ % 1000 !== 0, 'the end is confirmed inside a second');
  const before = await answerFlow(w, w.I1, early[0], await w.issue('u5e21-d-early', { sub: d, groups: [A], idp: Z, authTime: sec(endZ) }));
  assert.deepEqual([before.newSid, atProvider(before)], [null, true],
    'e: a fresh step started before the end counts from the confirmation: the same second before it is covered');
  w.tick(1000);
  const after = await answerFlow(w, w.I1, early[1], await w.issue('u5e21-d-after', { sub: d, groups: [A], idp: Z, authTime: sec(Date.now()) }));
  assert.equal(after.cookie, 'S', 'e: ... and the following second enters');
  // A fresh step started after the end, 700 ms into its second: one second before that second is not its authentication.
  w.tick(1000);
  const late = await refuseFlow(w, w.I1, await w.call(w.I1, 'switch', { body: UNTRUSTED }), 'login_required');
  const lateStart = Date.now();
  assert.ok(lateStart > (await confirmedAt(Z)) + 1000 && lateStart % 1000 !== 0);
  const endBeforeStale = await confirmedAt(Z);
  const tooEarly = await answerFlow(w, w.I1, late, await w.issue('u5e21-d-too-early', { sub: d, groups: [A], idp: Z, authTime: sec(lateStart) - 1 }));
  assert.deepEqual([tooEarly.newSid, atProvider(tooEarly), promptOf(tooEarly)], [null, true, 'login'],
    'e: authenticated a second before the fresh step\'s own second (after the end, but not by this step): covered, the step restarts');
  const own = await answerFlow(w, w.I1, tooEarly, await w.issue('u5e21-d-own', { sub: d, groups: [A], idp: Z, authTime: sec(Date.now()) }));
  assert.equal(await confirmedAt(Z), endBeforeStale, 'an old callback cannot re-confirm or reopen the mark');
  assert.equal(own.cookie, 'S', 'e: the restarted fresh step admits an authentication from the second it started');

  // ── g. keeping: from the last confirmation ──
  const at = hours => new Date(Date.now() - hours * HOUR);
  for (const [idp, decided, confirmed] of [['syn-idp-u5e21-reended', 14, 1], ['syn-idp-u5e21-old', 14, 14]])
    await w.base.idpSessionEnd.create({ data: { idpSid: idp, cause: 'logout', decidedAt: at(decided), confirmedAt: at(confirmed),
      attempts: 1, nextAttemptAt: at(decided) } });
  const sweeper = w.instance('S21');
  sweeper.service.onModuleInit();
  try {
    w.tick(HOUR);
    await w.until('the sweep of old confirmed marks', async () => (await w.mark('syn-idp-u5e21-old')) === null);
  } finally {
    sweeper.service.onModuleDestroy();
  }
  assert.ok(await w.mark('syn-idp-u5e21-reended'), 'g: decided 15 h ago, re-ended and confirmed 2 h ago: kept');
  await w.finish('U5E-21');
});

// S7-U5 D600 decisive case 1 (real PostgreSQL, controlled HTTP - the fake provider releases a request's effect and its
// answer independently): the isolation's disable reaches the provider, the product's wait for its answer ends (client
// timeout), an Activate comes, and only then does the provider carry the old disable out. While that call's own answer has
// not come, the Activate does not succeed and the isolation is not cleared. Once that call's own answer has come, the
// Activate succeeds and the member logs in and refreshes.
test('U5E-22 (D600 1) a disable whose wait timed out, then an Activate, then the late disable: no success or clear while it is unknown; after its own answer the Activate, a login and a refresh succeed', async t => {
  const w = await world(t);
  const { AdminService } = require('/app/dist/admin.service');
  const admin = new AdminService(w.I1.prisma, new KeycloakService(), null, w.I1.service);
  const caller = { roles: ['admin'], actor: 'syn-admin@synthetic.test', sub: 'syn-admin' };
  const fact = sub => w.base.memberIsolation.findUnique({ where: { sub } });
  const m = 'syn-sub-u5e22', L = 'syn-idp-u5e22-live';
  kc.members[m] = { username: m, email: m + '@synthetic.test', enabled: true, groups: [A], roles: ['radiologist'], sessions: [L] };
  const live = await w.session(await w.issue('u5e22-live', { sub: m, groups: [A], idp: L }));
  const effect = holdAdmin('PUT disable', 'before', m), answer = holdAdmin('PUT disable', 'after', m);
  // The Suspend: the fact, the member's session ended, the listing - and the disable, which the provider holds unexecuted.
  const from = performance.now();
  await assert.rejects(admin.patchUser(m, { enabled: false }, caller), error => error?.response?.code === 'USER_ISOLATED',
    'the Suspend does not say the isolation finished');
  await effect.arrived();
  assert.ok(performance.now() - from >= 9_000, 'the product waited for the disable\'s answer until its wait ended');
  assert.deepEqual([await w.changes(m, 'disable'), kc.members[m].enabled, await w.version(live), !!await fact(m), (await fact(m))?.providerDoneAt],
    [['unknown'], true, null, true, null], 'client timeout: the disable is unknown (sent, not carried out); the member still enabled at the provider');
  // The Activate comes; a second in, the provider carries the old disable out - its answer is still on its way.
  const run = activation(admin, m, caller);
  await pause(1000);
  effect.release();
  await w.until('the late disable carried out', async () => kc.members[m].enabled === false);
  const first = await run.result;
  assert.deepEqual([...unconfirmedOf(first), run.took < 15_000], [...UNCONFIRMED, true],
    'no success while the disable is unknown - 409 ACTIVATION_UNCONFIRMED within 15 s');
  assert.deepEqual([!!await fact(m), await w.changes(m, 'disable'), kc.adminCalls.includes('PUT enable')], [true, ['unknown'], false],
    'the isolation is kept, the old disable still unknown, nothing enabled');
  // That call's own answer comes: it settles it - and only now does the Activate succeed.
  answer.release();
  await w.until('the old disable settled by its own answer', async () => (await w.changes(m, 'disable'))[0] === 'done');
  const second = await activation(admin, m, caller).result;
  await quiet(w);
  assert.deepEqual([second.status, second.user?.enabled, kc.members[m].enabled, await fact(m)], [200, true, true, null],
    'after the old call\'s own answer: activated, enabled at the provider, the fact cleared');
  // The member logs in (a new provider session) and its session is refreshed.
  const S = 'syn-idp-u5e22-again';
  const entered = await login(w, w.I2, await w.issue('u5e22-again', { sub: m, groups: [A], idp: S }));
  assert.deepEqual([entered.done.cookie, !!entered.done.proof], ['S', true], 'the member logs in again');
  await w.base.authSession.updateMany({ where: { sid: entered.done.newSid }, data: { atExpiresAt: lapsed() } });
  const next = await w.issue('u5e22-next', { sub: m, groups: [A], idp: S });
  kc.auto = () => reply.tokens(next);
  const refreshed = await w.call(w.I1, 'get', { sid: entered.done.newSid });
  kc.auto = null;
  assert.deepEqual([refreshed.status, await w.version(entered.done.newSid)], [200, 'u5e22-next'], 'and its session refreshes');
  await w.finish('U5E-22');
});

// S7-U5 D600 decisive case 2: the old disable's effect is held past the product's wait and past a re-read of the provider's
// state (which still says the member is enabled - the disable has not been carried out). The only correct answer within 15 s
// is 409 ACTIVATION_UNCONFIRMED with the isolation kept. Then the effect is released and the member is disabled at the
// provider: an implementation that had answered success would now have a cleared isolation and a disabled member; this one
// still holds the isolation, and once that call has its own answer the next Activate leaves the member enabled for good.
test('U5E-23 (D600 2) the old disable\'s effect held past the deadline and a re-read: the only answer within 15 s is 409 ACTIVATION_UNCONFIRMED with the isolation kept; released afterwards, nothing contradicts it', async t => {
  const w = await world(t);
  const { AdminService } = require('/app/dist/admin.service');
  const admin = new AdminService(w.I1.prisma, new KeycloakService(), null, w.I1.service);
  const caller = { roles: ['admin'], actor: 'syn-admin@synthetic.test', sub: 'syn-admin' };
  const fact = sub => w.base.memberIsolation.findUnique({ where: { sub } });
  const m = 'syn-sub-u5e23', P = 'syn-idp-u5e23';
  // The isolation's listing fails and its disable does not connect (never sent): the member is still enabled, the work owed.
  await owedIsolation(admin, caller, m, P, { disable: false });
  assert.equal(kc.members[m].enabled, true);
  // The retry cycle sends its disable; the provider holds it unexecuted.
  const effect = holdAdmin('PUT disable', 'before', m);
  const cycle = w.instance('C23');
  cycle.service.onModuleInit();
  try {
    await effect.arrived();
    const run = activation(admin, m, caller);
    // The provider's state, read meanwhile, says enabled: a re-read is no evidence that the held disable cannot land.
    assert.equal((await new KeycloakService().getUser(m)).enabled, true, 're-read: enabled');
    const result = await run.result;
    assert.deepEqual([...unconfirmedOf(result), run.took < 15_000], [...UNCONFIRMED, true], 'the only answer within 15 s');
    assert.deepEqual([!!await fact(m), kc.adminCalls.includes('PUT enable')], [true, false], 'the isolation kept; nothing enabled');
    // The effect lands after the answer: the member is disabled at the provider - and the product still says isolated.
    effect.release();
    await w.until('the held disable carried out and answered', async () => (await w.changes(m, 'disable')).every(state => state !== 'unknown'));
    const login1 = await login(w, w.I2, await w.issue('u5e23-try', { sub: m, groups: [A], idp: P + '-try' }));
    assert.deepEqual([kc.members[m].enabled, !!await fact(m), login1.done.newSid,
      rowsOf(await w.rows(), m).filter(r => r.action === 'auth.login').at(-1).detail.cause], [false, true, null, 'member_isolated'],
      'consistent after the release: disabled at the provider and isolated here');
  } finally {
    effect.release();
    cycle.service.onModuleDestroy();
  }
  // Every change has its own answer now: the Activate succeeds, and nothing disables the member after it.
  const after = await activation(admin, m, caller).result;
  await quiet(w);
  assert.deepEqual([after.status, kc.members[m].enabled, await fact(m),
    kc.adminCalls.slice(kc.adminCalls.lastIndexOf('PUT enable') + 1).filter(c => c === 'PUT disable')], [200, true, null, []]);
  await w.finish('U5E-23');
});

// S7-U5 D600 decisive case 3: a late end request of a provider session whose sid the provider gives to the next SSO
// (D598). Doctor A logs out on a shared PC; the provider holds that end request unexecuted (its outcome unknown) while a
// second end request of the same sid (a new process's retry) is answered first. The end is not confirmed while the first is
// unknown: the next person B in the same browser, whose new SSO got the SAME sid, is not admitted (an admitted B would be
// ended when the held request lands); C's new SSO with a DIFFERENT sid enters meanwhile. Once the held request has its own
// answer the end is confirmed; B, authenticated after that, enters - and B's and C's sessions survive a refresh.
test('U5E-24 (D600 3) a late end request: another request\'s 204 answered first does not confirm the end; the next SSO with the same sid is not admitted until the late one has its own answer, one with another sid is; admitted sessions survive a refresh', async t => {
  const w = await world(t);
  const sec = ms => Math.floor(ms / 1000);
  const a = 'syn-sub-u5e24-a', b = 'syn-sub-u5e24-b', c = 'syn-sub-u5e24-c', X = 'syn-idp-u5e24-shared', Y = 'syn-idp-u5e24-other';
  const sidA = await w.session(await w.issue('u5e24-a', { sub: a, groups: [A], idp: X, authTime: sec(Date.now()) - 600 }));
  // A's Log out: its end request reaches the provider, which holds it unexecuted.
  const late = holdEnd(X, 'before');
  assert.equal((await w.call(w.I1, 'logout', { sid: sidA })).status, 204);
  await late.arrived();
  // A new process retries the unconfirmed end: that second request is carried out and answered 204 first.
  const retry = w.instance('R24');
  retry.service.onModuleInit();
  try {
    await w.until('the second end request answered', async () => (await w.changes(X)).length === 2 && (await w.changes(X))[1] === 'done');
  } finally {
    retry.service.onModuleDestroy();
  }
  assert.deepEqual([kc.ended.includes(X), await w.changes(X), (await w.mark(X)).confirmedAt], [true, ['unknown', 'done'], null],
    'the provider ended A\'s SSO; the first request is still unknown, so the end is not confirmed');
  // C, in another browser: a new SSO with another sid enters.
  w.tick(1000);
  const cEntered = await login(w, w.I2, await w.issue('u5e24-c', { sub: c, groups: [B], idp: Y, authTime: sec(Date.now()) }));
  assert.deepEqual([cEntered.done.cookie, !!cEntered.done.proof], ['S', true], 'another sid enters while the late request is unknown');
  // B, in A's browser: the provider names B's new SSO by the same sid (it is alive again under it), authenticated now.
  kc.ended = kc.ended.filter(sid => sid !== X);
  const bTry = await login(w, w.I2, await w.issue('u5e24-b-1', { sub: b, groups: [B], idp: X, authTime: sec(Date.now()) }));
  assert.deepEqual([bTry.done.location, bTry.done.newSid, await w.base.authSession.count({ where: { sub: b } }), (await w.mark(X)).confirmedAt],
    [landing('end_unconfirmed'), null, 0, null], 'the same sid is not admitted while a late end request of it may land');
  // The held request is carried out at last and has its own answer: now the end is confirmed.
  late.release();
  await w.until('the late request settled and the end confirmed', async () => (await w.mark(X))?.confirmedAt != null);
  assert.ok((await w.changes(X)).every(state => state === 'done'), 'every end request of the sid has its own answer');
  // B again, a new SSO of the same sid authenticated after that confirmation: enters with its credentials.
  w.tick(1000);
  kc.ended = kc.ended.filter(sid => sid !== X);
  const asked = kc.endRequests.length;
  const bEntered = await login(w, w.I2, await w.issue('u5e24-b-2', { sub: b, groups: [B], idp: X, authTime: sec(Date.now()) }));
  assert.deepEqual([bEntered.done.cookie, !!bEntered.done.proof], ['S', true], 'B enters once the late request has its own answer');
  // Both admitted sessions survive a refresh: no late end request is left to end them.
  for (const [who, sid, label, idp] of [[b, bEntered.done.newSid, 'u5e24-b-next', X], [c, cEntered.done.newSid, 'u5e24-c-next', Y]]) {
    await w.base.authSession.updateMany({ where: { sid }, data: { atExpiresAt: lapsed() } });
    const next = await w.issue(label, { sub: who, groups: [B], idp });
    kc.auto = () => reply.tokens(next);
    const refreshed = await w.call(w.I1, 'get', { sid });
    kc.auto = null;
    assert.deepEqual([refreshed.status, await w.version(sid)], [200, label], who + ': the admitted session refreshes');
  }
  await w.told();
  assert.deepEqual([kc.endRequests.length - asked, kc.ended.includes(X), kc.ended.includes(Y)], [0, false, false],
    'nothing ends B\'s or C\'s provider session after their admission');
  await w.finish('U5E-24');
});

// S7-U5 D600 decisive case 4: what does and does not settle an unknown change. Three members' disables whose outcome is
// lost three ways - its answer cut after the provider carried it out (reset), an ambiguous 500, and an answer the product
// stopped waiting for (timeout, the request still open). Then the clock advances an hour, a restarted process's cycle
// takes the owed work over, the provider state is read again, and another process's Activate comes: none of that settles
// them - every Activate answers 409 ACTIVATION_UNCONFIRMED within 15 s, the isolation kept. Only the timed-out request's
// own answer, when it finally comes, settles it; that member's next Activate succeeds. (Keycloak 26.7.3 has no
// provider-enforced way to rule an old request out - no cancellation, no conditional request - so the product has no other
// path and the reset and 500 records stay unknown.) The 15 s bound holds also when the service token must be fetched again
// after a 401 and that fetch hangs, and when the enable itself is held: answered in time, nothing cleared; a 401 that is
// re-acquired at once is just a successful Activate.
test('U5E-25 (D600 4) a lost answer, a 500 and a timed-out request stay unknown across an hour, a restart, a takeover and a re-read; only the request\'s own answer settles it; token fetch, 401 re-acquisition and a held enable stay inside 15 s', async t => {
  const w = await world(t);
  const { AdminService } = require('/app/dist/admin.service');
  const admin = new AdminService(w.I1.prisma, new KeycloakService(), null, w.I1.service);
  const caller = { roles: ['admin'], actor: 'syn-admin@synthetic.test', sub: 'syn-admin' };
  const fact = sub => w.base.memberIsolation.findUnique({ where: { sub } });
  const member = m => { kc.members[m] = { username: m, email: m + '@synthetic.test', enabled: true, groups: [A], roles: ['radiologist'], sessions: [] }; return m; };
  const reset = member('syn-sub-u5e25-reset'), error = member('syn-sub-u5e25-500'), slow = member('syn-sub-u5e25-timeout');
  const paused = member('syn-sub-u5e25-enable-held');
  // The paused member's isolation finishes cleanly first.
  assert.equal((await admin.patchUser(paused, { enabled: false }, caller)).enabled, false);
  holdAdmin('PUT disable', 'after', reset).release('drop');          // carried out, the answer cut
  holdAdmin('PUT disable', 'before', error).release('500');          // answered 500
  const held = holdAdmin('PUT disable', 'before', slow);              // held unexecuted past the wait
  const suspended = await Promise.all([reset, error, slow].map(m => admin.patchUser(m, { enabled: false }, caller).then(() => 'ok', e => e?.response?.code)));
  assert.deepEqual(suspended, ['USER_ISOLATED', 'USER_ISOLATED', 'USER_ISOLATED'], 'no Suspend can say its isolation finished');
  assert.deepEqual([await w.changes(reset, 'disable'), await w.changes(error, 'disable'), await w.changes(slow, 'disable')],
    [['unknown'], ['unknown'], ['unknown']], 'reset, 500 and timeout: unknown');
  // An hour later a restarted process's cycle takes the owed work over (and sends its own disables, which are answered).
  w.tick(HOUR);
  const restarted = w.instance('R25');
  restarted.service.onModuleInit();
  try {
    await w.until('the restarted cycle took the owed work over', async () =>
      (await Promise.all([reset, error, slow].map(m => w.changes(m, 'disable')))).every(states => states.length >= 2));
    await quiet(w);
  } finally {
    restarted.service.onModuleDestroy();
  }
  // The provider's state read again: all three disabled now - still no evidence about the first requests.
  for (const m of [reset, error, slow]) assert.equal((await new KeycloakService().getUser(m)).enabled, false, m + ': re-read');
  // Another process's Activates (and the held enable of the paused member, in the same 15 s).
  const enableHeld = holdAdmin('PUT enable', 'before', paused);
  const takeover = w.instance('T25');
  const otherAdmin = new AdminService(takeover.prisma, new KeycloakService(), null, takeover.service);
  const runs = [reset, error, slow, paused].map(m => activation(otherAdmin, m, caller));
  // While the paused member's own enable is unknown, a second Activate of it is no different: its own enable cannot settle
  // the first one.
  await enableHeld.arrived();
  runs.push(activation(admin, paused, caller));
  const results = await Promise.all(runs.map(run => run.result));
  for (const [n, m] of [reset, error, slow, paused, paused].entries())
    assert.deepEqual([...unconfirmedOf(results[n]), runs[n].took < 15_000, !!await fact(m)], [...UNCONFIRMED, true, true],
      m + ': 409 ACTIVATION_UNCONFIRMED within 15 s, the isolation kept');
  assert.deepEqual([(await w.changes(reset, 'disable'))[0], (await w.changes(error, 'disable'))[0], (await w.changes(slow, 'disable'))[0]],
    ['unknown', 'unknown', 'unknown'], 'an hour, a restart, a takeover and a re-read settled nothing');
  // The held enable is released after the answer: it lands (its own answer settles it); the paused member stays isolated
  // here (its login refused) until an Activate confirms everything.
  enableHeld.release();
  await w.until('the held enable settled', async () => (await w.changes(paused, 'enable'))[0] === 'done');
  const refused = await login(w, w.I2, await w.issue('u5e25-paused', { sub: paused, groups: [A], idp: 'syn-idp-u5e25-paused' }));
  assert.deepEqual([kc.members[paused].enabled, refused.done.newSid], [true, null], 'enabled at the provider by the late enable, still isolated here');
  assert.equal((await activation(admin, paused, caller).result).status, 200, 'then an Activate confirms it');
  // The timed-out request's own answer comes at last: that, and only that, settles it.
  held.release();
  await w.until('the timed-out disable settled by its own answer', async () => (await w.changes(slow, 'disable'))[0] === 'done');
  const settled = await activation(admin, slow, caller).result;
  assert.deepEqual([settled.status, kc.members[slow].enabled, await fact(slow)], [200, true, null], 'after its own answer: activated');
  // 401 then a working token endpoint: re-acquired inside the bound, a plain success.
  const stale = member('syn-sub-u5e25-401');
  assert.equal((await admin.patchUser(stale, { enabled: false }, caller)).enabled, false);
  kc.adminStale = { enable: 1 };
  const tokens = kc.serviceTokens;
  const reacquired = activation(admin, stale, caller);
  assert.deepEqual([(await reacquired.result).status, kc.serviceTokens - tokens, reacquired.took < 15_000], [200, 1, true],
    '401: the service token is fetched again and the enable sent again inside the bound');
  // 401 and a token endpoint that does not answer: the enable is never sent (no token), the Activate answers in time. In the
  // same 15 s the reset member's Activate again: nothing will ever answer that request, so it stays unconfirmed.
  const hang = member('syn-sub-u5e25-token-hang');
  assert.equal((await admin.patchUser(hang, { enabled: false }, caller)).enabled, false);
  kc.adminStale = { enable: 1 };
  kc.serviceMode = 'hang';
  try {
    const still = activation(admin, reset, caller);
    const run = activation(admin, hang, caller);
    const result = await run.result;
    assert.deepEqual([...unconfirmedOf(await still.result), still.took < 15_000], [...UNCONFIRMED, true], 'the reset stays unknown');
    // The bounded HTTP answer may win the event-loop turn before the aborted token fetch records its own not-sent answer.
    await w.until('the token acquisition records its own terminal answer', async () => (await w.changes(hang, 'enable'))[0] === 'void');
    assert.deepEqual([...unconfirmedOf(result), run.took < 15_000, !!await fact(hang), kc.members[hang].enabled, await w.changes(hang, 'enable')],
      [...UNCONFIRMED, true, true, false, ['void']], 'a token fetch that hangs: not sent (void), 409 within 15 s, isolation kept');
  } finally {
    kc.serviceMode = 'ok';
  }
  await w.finish('U5E-25');
});

// S7-U5 D600 decisive case 5: the opposite side, and the latest command.
//   a. The admin API freezes while an isolation's disable is in flight. An unrelated doctor's login, refresh and Log out
//      go through without waiting for it (they never ask the admin API; the Log out's provider end waits in the background),
//      and the isolated member's login is refused at once from our own fact - no store lock is held across the provider call.
//   b. An Activate's enable is held; a new Suspend arrives before the Activate completes. The old Activate cannot clear the
//      new isolation (its generation is gone) nor leave the member active: it answers a conflict, the member stays isolated
//      here, and the retry cycle - once the late enable has its own answer - disables the member and finishes.
test('U5E-26 (D600 5) with the admin API frozen ordinary doctors log in, refresh and log out at once and the isolated member is refused at once; a Suspend just before an Activate completes is not undone by it', async t => {
  const w = await world(t);
  const { AdminService } = require('/app/dist/admin.service');
  const admin = new AdminService(w.I1.prisma, new KeycloakService(), null, w.I1.service);
  const caller = { roles: ['admin'], actor: 'syn-admin@synthetic.test', sub: 'syn-admin' };
  const fact = sub => w.base.memberIsolation.findUnique({ where: { sub } });
  const quick = async (what, work) => {
    const from = performance.now();
    const out = await within(work(), what, 5000);
    return [out, performance.now() - from];
  };

  // (a)
  const m = 'syn-sub-u5e26-a', o = 'syn-sub-u5e26-other';
  kc.members[m] = { username: m, email: m + '@synthetic.test', enabled: true, groups: [A], roles: ['radiologist'], sessions: [] };
  const disable = holdAdmin('PUT disable', 'before', m);
  const suspending = admin.patchUser(m, { enabled: false }, caller);
  await disable.arrived();
  // From here the whole admin API is frozen: every member-administration request and every provider end request waits.
  const thaw = deferred();
  const frozen = { before: kc.beforeAdmin, end: kc.beforeEnd };
  kc.beforeAdmin = (name, id) => thaw.promise.then(() => frozen.before ? frozen.before(name, id) : undefined);
  kc.beforeEnd = id => thaw.promise.then(() => frozen.end ? frozen.end(id) : undefined);
  const calls = kc.adminCalls.length;
  try {
    const [isolated, isolatedMs] = await quick('the isolated member\'s login', async () =>
      login(w, w.I2, await w.issue('u5e26-isolated', { sub: m, groups: [A], idp: 'syn-idp-u5e26-isolated' })));
    assert.deepEqual([isolated.done.newSid, rowsOf(await w.rows(), m).filter(r => r.action === 'auth.login').at(-1).detail.cause, isolatedMs < 2000],
      [null, 'member_isolated', true], 'a: the isolated member is refused at once from our own fact');
    const [entered, enteredMs] = await quick('another doctor\'s login', async () =>
      login(w, w.I2, await w.issue('u5e26-other', { sub: o, groups: [A], idp: 'syn-idp-u5e26-other' })));
    assert.deepEqual([entered.done.cookie, !!entered.done.proof, enteredMs < 2000], ['S', true, true], 'a: an unrelated doctor logs in at once');
    await w.base.authSession.updateMany({ where: { sid: entered.done.newSid }, data: { atExpiresAt: lapsed() } });
    const next = await w.issue('u5e26-other-next', { sub: o, groups: [A], idp: 'syn-idp-u5e26-other' });
    kc.auto = () => reply.tokens(next);
    const [refreshed, refreshMs] = await quick('another doctor\'s refresh', () => w.call(w.I1, 'get', { sid: entered.done.newSid }));
    kc.auto = null;
    assert.deepEqual([refreshed.status, await w.version(entered.done.newSid), refreshMs < 2000], [200, 'u5e26-other-next', true],
      'a: and refreshes at once');
    const [loggedOut, logoutMs] = await quick('another doctor\'s Log out', () => w.call(w.I1, 'logout', { sid: entered.done.newSid }));
    assert.deepEqual([loggedOut.status, await w.version(entered.done.newSid), logoutMs < 2000], [204, null, true],
      'a: and logs out at once (the provider end waits in the background)');
    assert.deepEqual(kc.adminCalls.slice(calls), [], 'a: none of them asked the member administration');
  } finally {
    thaw.resolve();
    disable.release();
  }
  assert.equal((await suspending).enabled, false, 'a: the Suspend finishes once the admin API answers');
  await w.told();

  // (b)
  const n = 'syn-sub-u5e26-b';
  kc.members[n] = { username: n, email: n + '@synthetic.test', enabled: true, groups: [A], roles: ['radiologist'], sessions: [] };
  assert.equal((await admin.patchUser(n, { enabled: false }, caller)).enabled, false);
  const enable = holdAdmin('PUT enable', 'before', n);
  const run = activation(admin, n, caller);
  await enable.arrived();
  // The new Suspend lands before the Activate completes: our fact is the newest command at once; its provider work cannot
  // be called finished while the old enable is unknown.
  const again = await admin.patchUser(n, { enabled: false }, caller).then(() => 'ok', e => e?.response?.code);
  assert.deepEqual([again, !!await fact(n), (await fact(n))?.providerDoneAt], ['USER_ISOLATED', true, null], 'b: the new Suspend is recorded, its work owed');
  // The old enable lands and is answered: the old Activate may not clear the new isolation or report success.
  enable.release();
  const old = await run.result;
  assert.deepEqual([old.status === 200, old.body?.code, !!await fact(n)], [false, 'USER_ISOLATED', true],
    'b: the old Activate answers a conflict; the new isolation stays');
  const refused = await login(w, w.I2, await w.issue('u5e26-b-try', { sub: n, groups: [A], idp: 'syn-idp-u5e26-b-try' }));
  assert.equal(refused.done.newSid, null, 'b: the member is refused (isolated here) although the late enable enabled it at the provider');
  // The retry cycle, the old enable now answered, disables the member and finishes the new isolation.
  const cycle = w.instance('C26');
  cycle.service.onModuleInit();
  try {
    await w.until('b: the cycle finished the new isolation', async () => (await fact(n))?.providerDoneAt != null);
  } finally {
    cycle.service.onModuleDestroy();
  }
  assert.deepEqual([kc.members[n].enabled, !!await fact(n)], [false, true], 'b: disabled and isolated - the latest command stands');
  await w.finish('U5E-26');
});

// S7-U5 fix round 7 (Astra, fix-6 decision b): a 503 to a CHANGE request is not proof that the provider turned it away
// before carrying it out - Keycloak sheds queued requests with 503, but its error handler also answers the status of an
// exception raised while handling a request - so the change stays unknown, like a 500.
//   a. An end request carried out and then answered 503, and one answered 503 without being carried out: each stays
//      unknown. Another request's 404 / 204 for the same sid, a restart and an hour do not settle it; the mark stays
//      unconfirmed and the sid's next login is refused.
//   b. A disable carried out and answered 503, an enable answered 503: unknown. The retry cycle's own answered disable and a
//      re-read of the provider settle nothing; the Activate answers 409 ACTIVATION_UNCONFIRMED within 15 s, the isolation
//      is kept and the member's login refused.
//   c. Opposite side: a 503 to the service account's TOKEN request means the change was never sent - void, nothing reaches
//      the provider, and nothing is left that blocks: the next answered request confirms the end / the next Activate succeeds.
test('U5E-27 (fix round 7) a 503 to a change request leaves it unknown whether or not it was carried out: no other request, re-read, restart or hour settles it; a 503 to the token request means not sent (void)', async t => {
  const w = await world(t);
  const { AdminService } = require('/app/dist/admin.service');
  const admin = new AdminService(w.I1.prisma, new KeycloakService(), null, w.I1.service);
  const caller = { roles: ['admin'], actor: 'syn-admin@synthetic.test', sub: 'syn-admin' };
  const fact = sub => w.base.memberIsolation.findUnique({ where: { sub } });
  const member = m => { kc.members[m] = { username: m, email: m + '@synthetic.test', enabled: true, groups: [A], roles: ['radiologist'], sessions: [] }; return m; };
  // The answer of a record has come in (its summary noted) - its state is what the answer decided.
  const answered = async (target, kind) => (await w.base.providerChange.findMany({ where: kind ? { target, kind } : { target }, orderBy: { id: 'asc' } }))
    .map(row => row.outcome !== null);
  const refusedLogin = async (label, sub, idp) => {
    const begin = await w.call(w.I2, 'login');
    return answerFlow(w, w.I2, begin, await w.issue(label, { sub, groups: [A], idp }));
  };

  // (a)
  const a = 'syn-sub-u5e27-a', X = 'syn-idp-u5e27-carried', b = 'syn-sub-u5e27-b', Y = 'syn-idp-u5e27-shed';
  const sidA = await w.session(await w.issue('u5e27-a', { sub: a, groups: [A], idp: X }));
  const sidB = await w.session(await w.issue('u5e27-b', { sub: b, groups: [A], idp: Y }));
  holdEnd(X, 'after').release('503');
  assert.equal((await w.call(w.I1, 'logout', { sid: sidA })).status, 204);
  // (The end request goes out after the Log out's answer: X's answer is taken in before the next mode.)
  await w.until('a: X\'s 503 taken in', async () => (await answered(X)).every(Boolean) && (await answered(X)).length === 1);
  kc.logoutMode = 'error';
  assert.equal((await w.call(w.I1, 'logout', { sid: sidB })).status, 204);
  await w.until('a: Y\'s 503 taken in', async () => (await answered(Y)).every(Boolean) && (await answered(Y)).length === 1);
  kc.logoutMode = 'ok';
  assert.deepEqual([kc.ended.includes(X), kc.ended.includes(Y), await w.changes(X), await w.changes(Y), (await w.mark(X)).confirmedAt, (await w.mark(Y)).confirmedAt],
    [true, false, ['unknown'], ['unknown'], null, null], 'a: carried out or not, a 503 leaves the end unknown and unconfirmed');
  // A new process asks again: X is answered "no such session" (404), Y is ended now (204) - those requests only.
  const asked = kc.endRequests.length;
  const restarted = w.instance('R27');
  restarted.service.onModuleInit();
  try {
    await w.until('a: the ends asked again and answered', async () =>
      (await w.changes(X)).length >= 2 && (await w.changes(Y)).length >= 2 && (await answered(X)).concat(await answered(Y)).every(Boolean));
    w.tick(HOUR);
    await quiet(w);
  } finally {
    restarted.service.onModuleDestroy();
  }
  assert.ok(kc.endRequests.length > asked && kc.ended.includes(Y), 'a: the later requests reached the provider; Y is ended now');
  for (const sid of [X, Y]) {
    const states = await w.changes(sid);
    assert.deepEqual([states[0], states.slice(1).every(state => state === 'done'), (await w.mark(sid)).confirmedAt], ['unknown', true, null],
      sid + ': another request\'s 404/204, a restart and an hour settle nothing; the end stays unconfirmed');
  }
  for (const [label, sub, sid] of [['u5e27-a-again', a, X], ['u5e27-b-again', b, Y]]) {
    const again = await refusedLogin(label, sub, sid);
    assert.deepEqual([again.location, again.newSid], [landing('end_unconfirmed'), null], sid + ': the sid\'s next login is refused');
  }

  // (b)
  const d = member('syn-sub-u5e27-disable'), e = member('syn-sub-u5e27-enable');
  holdAdmin('PUT disable', 'after', d).release('503');                  // carried out, answered 503
  assert.equal(await admin.patchUser(d, { enabled: false }, caller).then(() => 'ok', error => error?.response?.code), 'USER_ISOLATED',
    'b: the Suspend does not say its isolation finished');
  await w.until('b: the disable\'s 503 taken in', async () => (await answered(d, 'disable')).every(Boolean));
  assert.deepEqual([await w.changes(d, 'disable'), kc.members[d].enabled], [['unknown'], false], 'b: disabled at the provider, the record unknown');
  const cycle = w.instance('C27');
  cycle.service.onModuleInit();
  try {
    await w.until('b: the cycle\'s own disable answered', async () => (await w.changes(d, 'disable')).length >= 2
      && (await w.changes(d, 'disable')).slice(1).every(state => state === 'done'));
    await quiet(w);
  } finally {
    cycle.service.onModuleDestroy();
  }
  assert.equal((await new KeycloakService().getUser(d)).enabled, false, 'b: re-read: disabled - no evidence about the first request');
  assert.equal((await admin.patchUser(e, { enabled: false }, caller)).enabled, false);
  kc.adminFail = { enable: 1 };                                          // answered 503, not carried out
  const first = await activation(admin, e, caller).result;
  kc.adminFail = {};
  assert.deepEqual([...unconfirmedOf(first), await w.changes(e, 'enable'), kc.members[e].enabled, !!await fact(e)],
    [...UNCONFIRMED, ['unknown'], false, true], 'b: the enable answered 503 is unknown; 409, the isolation kept');
  const runs = [d, e].map(m => activation(admin, m, caller));
  const results = await Promise.all(runs.map(run => run.result));
  for (const [n, m] of [d, e].entries()) {
    assert.deepEqual([...unconfirmedOf(results[n]), runs[n].took < 15_000, !!await fact(m)], [...UNCONFIRMED, true, true],
      m + ': 409 ACTIVATION_UNCONFIRMED within 15 s, the isolation kept');
    const tried = await refusedLogin(m + '-try', m, 'syn-idp-' + m + '-try');
    assert.deepEqual([tried.newSid, rowsOf(await w.rows(), m).filter(r => r.action === 'auth.login').at(-1).detail.cause],
      [null, 'member_isolated'], m + ': its login refused');
  }
  assert.deepEqual([(await w.changes(d, 'disable'))[0], (await w.changes(e, 'enable'))[0]], ['unknown', 'unknown'], 'b: still unknown');

  // (c) the token request answered 503: nothing sent.
  const q = member('syn-sub-u5e27-token');
  assert.equal((await admin.patchUser(q, { enabled: false }, caller)).enabled, false);
  const enables = kc.adminCalls.length;
  kc.adminStale = { enable: 1 };                                         // the held token refused: a new one is asked for
  kc.serviceMode = 'error';
  let refused;
  try {
    refused = await activation(admin, q, caller).result;
  } finally {
    kc.serviceMode = 'ok';
  }
  assert.deepEqual([...unconfirmedOf(refused), await w.changes(q, 'enable'), kc.adminCalls.slice(enables).filter(c => c === 'PUT enable').length],
    [...UNCONFIRMED, ['void'], 1], 'c: the enable after the refused token was never sent (void); only the 401-answered one arrived');
  assert.deepEqual([(await activation(admin, q, caller).result).status, kc.members[q].enabled, await fact(q)], [200, true, null],
    'c: nothing unknown is left: the next Activate succeeds');
  const r = 'syn-sub-u5e27-token-end', Z = 'syn-idp-u5e27-token-end';
  const sidR = await w.session(await w.issue('u5e27-token-end', { sub: r, groups: [A], idp: Z }));
  w.tick(10 * 60_000);                                                   // the held service token has expired
  const arrived = kc.logouts;
  kc.serviceMode = 'error';
  try {
    assert.equal((await w.call(w.I1, 'logout', { sid: sidR })).status, 204);
    await w.until('c: the end settled without being sent', async () => (await w.changes(Z))[0] === 'void');
  } finally {
    kc.serviceMode = 'ok';
  }
  assert.deepEqual([kc.logouts - arrived, kc.endRequests.includes(Z), (await w.mark(Z)).confirmedAt], [0, false, null],
    'c: nothing reached the provider; the end is not confirmed yet');
  const resumer = w.instance('Z27');
  resumer.service.onModuleInit();
  try {
    await w.until('c: the end asked again and confirmed', async () => (await w.mark(Z)).confirmedAt !== null);
  } finally {
    resumer.service.onModuleDestroy();
  }
  assert.deepEqual(await w.changes(Z), ['void', 'done'], 'c: a request never sent blocks nothing');
  await w.finish('U5E-27');
});

// S7-U5 fix round 9 (review N-1 of c282c6b; D600 line 6 "current-generation-conditional"): an Activate deletes the member's
// isolation fact and the next Suspend writes a new one, so the generation must tell the two isolations apart - nothing that
// worked for the earlier isolation may complete, change or clear the later one. A provider READ (a session listing) is not a
// change call, so an Activate does not wait for it; a listing answered after its sender lost the work is discarded.
//   a. Suspend #1's isolation is held in its second listing (after its disable); an Activate succeeds; Suspend #2 writes a
//      new fact and is held in its first listing. Released, the stalled work of #1 records nothing for #2 and sends nothing:
//      #2 is not recorded finished (the member is enabled at the provider at that moment) and Suspend #1 does not say its
//      isolation finished. Released, Suspend #2 finishes as itself: disabled at the provider after the Activate's enable,
//      recorded finished, nothing unknown - no isolation is left recorded finished while the member is enabled.
//   b. A listing names provider session P and the work that listed it is held - (1) Suspend #1's first listing, its answer
//      held; (2) the retry cycle's listing answered, the cycle held just before the store transaction of its first mark. An
//      Activate finishes the work itself (P marked and ended by its id, the end confirmed), enables and clears; the member
//      signs in again and the provider gives the new SSO the same id P (D598). The held work then goes on with its list: it
//      marks nothing, asks no end of P and ends nothing - the member's new session and its SSO live, P's end stays confirmed.
//   c. The retry cycle read the owed fact of an isolation; before it takes the work over, an Activate clears that fact and
//      a new Suspend writes another, held in its first listing. The cycle takes nothing over (what it read is gone, even
//      if the new fact's counter is the same) and asks the provider nothing; the new Suspend finishes as itself.
//   d. Opposite side: an isolation held in its second listing while other members' isolations are written and cleared
//      resumes and finishes - its own generation is unchanged.
// What a case holds is the fake provider's request or answer (beforeAdmin / onAdmin) or the harness gate before a store
// transaction, so the order is the same on the stand-in and on PostgreSQL.
test('U5E-28 (fix round 9) an isolation\'s generation is never reused: work of an earlier isolation, resumed after an Activate and a new Suspend, completes, changes and ends nothing of the new one; the same isolation resumed still finishes', async t => {
  const w = await world(t);
  const { AdminService } = require('/app/dist/admin.service');
  const admin = new AdminService(w.I1.prisma, new KeycloakService(), null, w.I1.service);
  const caller = { roles: ['admin'], actor: 'syn-admin@synthetic.test', sub: 'syn-admin' };
  const fact = sub => w.base.memberIsolation.findUnique({ where: { sub } });
  const member = (m, sessions = []) => { kc.members[m] = { username: m, email: m + '@synthetic.test', enabled: true, groups: [A], roles: ['radiologist'], sessions }; return m; };
  const answerOf = p => p.then(user => ({ status: 200, enabled: user?.enabled }),
    error => ({ status: typeof error?.getStatus === 'function' ? error.getStatus() : 500, code: error?.response?.code ?? String(error) }));
  const suspend = m => answerOf(admin.patchUser(m, { enabled: false }, caller));
  const memberChanges = () => kc.adminCalls.filter(c => c === 'PUT disable' || c === 'PUT enable');
  const sec = ms => Math.floor(ms / 1000);
  // A Suspend held in its second listing: the provider read that follows its answered disable.
  const heldAfterDisable = async m => {
    const disable = holdAdmin('PUT disable', 'after', m);
    const run = suspend(m);
    await disable.arrived();
    const listing = holdAdmin('GET sessions', 'before', m);
    disable.release();
    await listing.arrived();
    return { run, release: () => listing.release() };
  };

  // (a)
  {
    const m = member('syn-sub-u5e28a');
    const first = await heldAfterDisable(m);
    const act = await activation(admin, m, caller).result;
    assert.deepEqual([act.status, act.user?.enabled, await fact(m), kc.members[m].enabled], [200, true, null, true],
      'a: the Activate succeeded while the first isolation\'s listing was held: enabled, the fact cleared');
    const second = holdAdmin('GET sessions', 'before', m);
    const s2 = suspend(m);
    await second.arrived();
    const secondFact = await fact(m);
    assert.deepEqual([!!secondFact, secondFact.providerDoneAt, kc.members[m].enabled], [true, null, true],
      'a: the second Suspend wrote a new fact, its work owed; the member is still enabled at the provider');
    const changes = await w.base.providerChange.count({ where: { sub: m } }), calls = memberChanges().length;
    first.release();
    const s1 = await first.run;
    assert.deepEqual([s1, (await fact(m)).providerDoneAt, memberChanges().length - calls, await w.base.providerChange.count({ where: { sub: m } }) - changes],
      [{ status: 409, code: 'USER_ISOLATED' }, null, 0, 0],
      'a: the first isolation\'s resumed work records the new isolation as nothing, sends and records no change; the first Suspend does not say it finished');
    second.release();
    const s2Answer = await s2;
    await quiet(w);
    const after = await fact(m), order = memberChanges();
    assert.deepEqual([s2Answer, !!after?.providerDoneAt, kc.members[m].enabled, order.lastIndexOf('PUT disable') > order.lastIndexOf('PUT enable'),
      await w.base.providerChange.count({ where: { sub: m, state: 'unknown' } })], [{ status: 200, enabled: false }, true, false, true, 0],
      'a: the second Suspend finishes as itself - disabled after the Activate\'s enable, recorded finished, nothing unknown');
  }

  // (b)
  for (const place of ['1', '2']) {
    const at = 'b' + place + (place === '1' ? ', the first listing\'s answer held' : ', the cycle held before its first mark');
    const P = 'syn-idp-u5e28b' + place;
    const m = 'syn-sub-u5e28b' + place;
    let resume, finished, cycle = null;
    if (place === '1') {
      member(m, [P]);
      const late = holdAdmin('GET sessions', 'after', m);
      finished = suspend(m);
      await late.arrived();
      resume = () => late.release();
    } else {
      await owedIsolation(admin, caller, m, P);
      // The cycle's first store transaction takes the owed work over; its second marks what its listing named.
      cycle = w.instance('C28b');
      const taken = w.gate('C28b', 'tx.open'), marking = w.gate('C28b', 'tx.open');
      cycle.service.onModuleInit();
      await taken.arrived();
      taken.release();
      await marking.arrived();
      resume = () => marking.release();
    }
    try {
      const act = activation(admin, m, caller);
      const result = await act.result;
      assert.deepEqual([result.status, act.took < 15_000, await fact(m), kc.ended.includes(P), (await w.mark(P))?.confirmedAt != null,
        (await w.changes(P)).every(state => state === 'done')], [200, true, null, true, true, true],
        at + ': the Activate listed P itself, ended it by its id (confirmed) and cleared the fact');
      // The member signs in again in the same browser: the provider gives the new SSO the id P again.
      w.tick(1000);
      kc.ended = kc.ended.filter(sid => sid !== P);
      const again = await login(w, w.I2, await w.issue('u5e28b-again-' + place, { sub: m, groups: [A], idp: P, authTime: sec(Date.now()) }));
      assert.deepEqual([again.done.cookie, !!again.done.proof], ['S', true], at + ': the active member enters with the new SSO');
      const ends = (await w.changes(P)).length, asked = kc.endRequests.filter(sid => sid === P).length, calls = kc.adminCalls.length;
      resume();
      if (finished) assert.deepEqual(await finished, { status: 409, code: 'USER_ISOLATED' }, at + ': the first Suspend does not say it finished');
      await quiet(w);
      await w.told();
      assert.deepEqual([await w.base.authSession.count({ where: { sub: m } }), await w.version(again.done.newSid), kc.ended.includes(P),
        (await w.mark(P))?.confirmedAt != null, (await w.changes(P)).length - ends, kc.endRequests.filter(sid => sid === P).length - asked,
        kc.adminCalls.slice(calls).filter(c => c.startsWith('PUT')), await fact(m), kc.members[m].enabled],
        [1, 'u5e28b-again-' + place, false, true, 0, 0, [], null, true],
        at + ': the late list marks nothing and ends nothing: the new session and its SSO live, P\'s end stays confirmed, nothing is sent');
    } finally {
      resume();
      if (cycle) cycle.service.onModuleDestroy();
    }
  }

  // (c)
  {
    const P = 'syn-idp-u5e28c';
    const m = 'syn-sub-u5e28c';
    await owedIsolation(admin, caller, m, P);
    const owed = await fact(m);
    assert.deepEqual([!!owed, owed?.providerDoneAt], [true, null], 'c: the isolation\'s work is owed');
    // The cycle has read the owed fact and is held before the store transaction that would take it over.
    const cycle = w.instance('C28c');
    const taking = w.gate('C28c', 'tx.open');
    cycle.service.onModuleInit();
    try {
      await taking.arrived();
      assert.equal((await activation(admin, m, caller).result).status, 200, 'c: the Activate finished the work and cleared the fact');
      const second = holdAdmin('GET sessions', 'before', m);
      const s2 = suspend(m);
      await second.arrived();
      const calls = kc.adminCalls.length, changes = await w.base.providerChange.count({ where: { sub: m } });
      taking.release();
      await quiet(w);
      assert.deepEqual([kc.adminCalls.slice(calls), await w.base.providerChange.count({ where: { sub: m } }) - changes, (await fact(m)).providerDoneAt],
        [[], 0, null], 'c: the cycle takes nothing over - it asks the provider nothing and records nothing for the new isolation');
      second.release();
      assert.deepEqual(await s2, { status: 200, enabled: false }, 'c: the new Suspend finishes as itself');
    } finally {
      taking.release();
      cycle.service.onModuleDestroy();
    }
    await quiet(w);
    assert.deepEqual([!!(await fact(m))?.providerDoneAt, kc.members[m].enabled], [true, false]);
  }

  // (d)
  {
    const m = member('syn-sub-u5e28d');
    const held = await heldAfterDisable(m);
    // Other members' isolations are written and cleared meanwhile.
    for (const other of [member('syn-sub-u5e28d-x'), member('syn-sub-u5e28d-y')]) {
      assert.deepEqual(await suspend(other), { status: 200, enabled: false });
      assert.equal((await activation(admin, other, caller).result).status, 200);
    }
    held.release();
    assert.deepEqual(await held.run, { status: 200, enabled: false }, 'd: the same isolation, resumed, finishes');
    assert.deepEqual([!!(await fact(m))?.providerDoneAt, kc.members[m].enabled, await w.base.providerChange.count({ where: { sub: m, state: 'unknown' } })],
      [true, false, 0], 'd: recorded finished, disabled at the provider, nothing unknown');
  }
  await w.finish('U5E-28');
});
