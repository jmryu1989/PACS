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
  beforeEnd: null, afterEnd: null, hung: [], adminStale: {}, adminRefuse: {}, transportTimeoutMs: 0, closedPort: 0 };

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
      if (path === '/admin/realms/kin/users' && req.method === 'GET') {
        if(kc.realmReadStatus)return send(kc.realmReadStatus,{error:'realm_unavailable'});
        const query = new URL(req.url, 'http://synthetic.test').searchParams;
        const first = Number(query.get('first') || 0), max = Number(query.get('max') || 100);
        return send(200, Object.entries(kc.members).map(([id, user]) => ({id,...user})).slice(first,first+max));
      }
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
  if (end ? kc.logoutMode === 'refused' : kc.adminRefuse[change] > 0) {
    if (end) kc.endRequests.push(decodeURIComponent(end[1]));
    else { kc.adminRefuse[change]--; kc.adminCalls.push('PUT ' + change); }
    input = url.replace(`//127.0.0.1:${kc.port}/`, `//127.0.0.1:${kc.closedPort}/`);
  }
  if (!end) return realFetch(input, init);
  idp.started++;
  idp.open++;
  const settle = () => { idp.open--; };
  if (end && kc.transportTimeoutMs) init = { ...init, signal: AbortSignal.timeout(kc.transportTimeoutMs) };
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
    if (status === 200) assert.deepEqual(me.body.roles, roles.filter(r => ['admin','radiologist','technician','clinician'].includes(r)), label);
    assert.deepEqual(coded(await w.call(w.I2, 'entry', { sid: done.newSid, body: { proof: done.proof } })),
      [403, 'AUTH_ENTRY_REFUSED', 'AUTH_ENTRY_REFUSED'], label);
    assert.equal(rowsOf(await w.rows(), sub).filter(row => row.action === 'auth.entry').length, 1, label);
  }
  await w.finish('U5S-ENTRY-01');
});

test('U5S-ENTRY-02 bound me after proof consumption uses DB rights when refreshed JWT claims change', async t => {
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
    assert.equal(me.status, 200, label);
    assert.deepEqual(me.body.roles, before, label);
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

async function world(t, { now = START, imported = true } = {}) {
  const base = await database();
  await keycloak();
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now });
  await base.$executeRawUnsafe('TRUNCATE "AuthSession"');
  await base.$executeRawUnsafe('TRUNCATE "IdpSessionEnd"');
  await base.$executeRawUnsafe('TRUNCATE "MemberIsolation"');
  await base.$executeRawUnsafe('TRUNCATE "MemberRights"');
  await base.$executeRawUnsafe('TRUNCATE "MemberRightsImport"');
  await base.$executeRawUnsafe('TRUNCATE "ProviderChange" RESTART IDENTITY');
  await base.$transaction([base.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    base.$executeRawUnsafe(`TRUNCATE "AuditLog" RESTART IDENTITY`)]);
  const [{ left }] = await base.$queryRawUnsafe(`SELECT (SELECT count(*) FROM "AuditLog") + (SELECT count(*) FROM "AuthSession") + (SELECT count(*) FROM "IdpSessionEnd") + (SELECT count(*) FROM "MemberIsolation") + (SELECT count(*) FROM "ProviderChange") AS left`);
  assert.equal(Number(left), 0, 'every world starts with no session, no end mark, no isolation fact, no provider change record and no audit row');
  Object.assign(kc, { held: [], waiters: [], auto: null, logoutMode: 'ok', onLogout: null, logouts: 0, tokens: 0, codes: [],
    certs: 'ok', certRequests: 0, abandoned: 0, ended: [], alive: null, serviceTokens: 0, serviceMode: 'ok', endRequests: [],
    members: {}, userLogouts: [], adminDown: false, adminFail: {}, adminCalls: [], onAdmin: null, beforeAdmin: null,
    beforeEnd: null, afterEnd: null, hung: [], adminStale: {}, adminRefuse: {}, transportTimeoutMs: 0, realmReadStatus:0 });
  if (imported) await base.memberRightsImport.create({ data: { id: 'realm-v1' } });
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
    if (model === 'memberIsolation' || model === 'memberRights' || model === 'providerChange') return model + '.' + method;
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
        await observe({ inst, model: '$transaction', phase: 'started', client: tx });
        const view = new Proxy({}, { get(_t, k) {
          if (['authSession', 'auditLog', 'idpSessionEnd', 'memberIsolation', 'memberRights', 'memberRightsImport', 'providerChange'].includes(k)) return delegate(inst, tx, k, 'tx');
          const value = tx[k];
          // The scenarios advance a virtual provider/application clock. Project DB timestamps onto that timeline;
          // CORE_COMMAND_DB_CLOCK opts out and proves the boundary against the actual PG transaction clock.
          if (k === '$queryRaw') return async (...args) => {
            const result = await value.apply(tx,args);
            if (w.realDatabaseClock) return result;
            return result.map(row => Object.fromEntries(Object.entries(row).map(([key,v]) => [key,v instanceof Date ? new Date() : v])));
          };
          if (k === '$executeRaw') return async (...args) => {
            await observe({ inst, scope:'tx', model:'$executeRaw', method:'execute', args, phase:'before' });
            const result = await value.apply(tx,args);
            await observe({ inst, scope:'tx', model:'$executeRaw', method:'execute', args, result, phase:'after' });
            return result;
          };
          return typeof value === 'function' ? value.bind(tx) : value;
        } });
        const out = await fn(view);
        w.calls.push(inst + ':tx:end');
        return out;
      }, options);
      await observe({ inst, model: '$transaction', phase: 'after', result });
      return result;
    };
    if (['authSession', 'auditLog', 'idpSessionEnd', 'memberIsolation', 'memberRights', 'memberRightsImport', 'providerChange'].includes(key)) return delegate(inst, base, key, 'root');
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
      health: ['GET', '/api/health', PacsController, PacsController.prototype.health],
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
      else if (kind === 'health') res.status(200).send(await new PacsController(null, inst.service).health());
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
  w.issue = async (label, { sub, groups = [A], email, roles = ['radiologist'], expIn = HOUR / 1000, key = 'main', same, idp, authTime, identity = {} } = {}) => {
    // Provisioning fixture, independent of token issuance after the first version. JWT changes never change this row.
    const cleanGroups = groups.filter(g => typeof g === 'string').map(g => g.replace(/^\//, ''));
    const managedRoles = roles.filter(role => ['admin','radiologist','technician','clinician'].includes(role));
    if (!await base.memberRights.findUnique({where:{sub}})) await base.memberRights.create({ data: { sub, username: sub, email: email ?? sub + '@synthetic.test',
      name: sub, emailVerified: true, approved: cleanGroups.length === 1 && managedRoles.length > 0 && !roles.includes('gateway'),
      suspended: false, institution: cleanGroups.length === 1 ? cleanGroups[0] : null, roles: managedRoles, version: 1 } });
    const now = Math.floor(Date.now() / 1000);
    const jti = label + '-' + randomUUID();
    const sid = idp === undefined ? 'syn-idp-' + sub : idp;
    const access = await new jose.SignJWT({ email: email ?? sub + '@synthetic.test', groups, realm_access: { roles }, azp: 'kin-bff', jti, preferred_username:sub, name:sub, email_verified:true,
      ...(sid === null ? {} : { sid }), ...(authTime === undefined ? {} : { auth_time: authTime }), ...identity })
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
    const rights = await base.memberRights.findUnique({ where: { sub: v.sub } });
    await base.authSession.create({ data: { rightsVersion: rights.version, institution: rights.institution, sid, sub: v.sub, accessToken: v.access, refreshToken: v.refresh, atExpiresAt, lastSeenAt,
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
async function answerFlow(w, inst, begin, v, { ip = IP, sid, cookies = [], nonce } = {}) {
  const state = new URL(begin.location).searchParams.get('state');
  w.secret('state', state);
  const code = 'syn-code-' + randomUUID();
  w.secret('code', code);
  const identity = await new jose.SignJWT({ nonce: nonce ?? state, auth_time: jose.decodeJwt(v.access).auth_time ?? Math.floor(Date.now()/1000) })
    .setProtectedHeader({ alg: 'RS256', kid: KEYS.main.kid }).setIssuer(ISSUER).setAudience('kin-bff').setSubject(v.sub)
    .setIssuedAt().setExpirationTime(Math.floor(Date.now()/1000)+3600).sign(KEYS.main.privateKey);
  w.secret('id-token', identity);
  kc.auto = form => form.grant_type === 'authorization_code' ? [200, {...reply.tokens(v)[1], id_token: identity}] : reply.reject();
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
    const result = await login(w, w.I1, v);
    if (!expected || !roles.length) {
      assert.ok(result.done.newSid, label + ': waiting identity has a session but no rights');
      assert.equal((await w.call(w.I2, 'get', { bearer: v.access })).status, 403, label);
      assert.equal((await w.call(w.I1, 'me', {sid:result.done.newSid})).status,403,label);
      continue;
    }
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
  await w.I2.service.onModuleInit();
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
  await w.I2.service.onModuleInit();
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
    await w.I2.service.onModuleInit();
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
  await w.I2.service.onModuleInit();
  try {
    for (const [end, row] of [['switch', ['auth.logout', 'account_switch', A]], ['logout', ['auth.logout', 'logout', A]],
      ['idle', ['auth.session.expired', 'idle', A]], ['sweep', ['auth.session.expired', 'sweep', A]]]) {
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
  await w.I2.service.onModuleInit();
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
    await w.I2.service.onModuleInit();
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
        [401, 'K', null, [['auth.session.expired', 'refresh_failed', A]]]);
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

test('AS-12 T8 (RT-06, X-23): an account switch read v1; v2 (B) is stored before its delete; it ends v2 and retains DB institution A', async t => {
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
      [200, 'P', null, [['auth.logout', kind === 'switch' ? 'account_switch' : 'reauthentication', A]]], kind);
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
  assert.deepEqual([out.status, out.cookie, await w.version(sid), await endsOf(w, s)], [200, 'P', null, [['auth.logout', 'account_switch', A]]]);
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
    [204, 'K', 0, 1, null, [['auth.logout', 'logout', A]]]);
  // X-33: after the third conflict the session is already gone (I2 logged out): the end completes, 409 is not given,
  // and the row is the one of the transition that deleted it.
  for (const kind of ['switch', 'logout']) {
    s = 'syn-sub-t9-absent-' + kind;
    ({ out, sid } = await interleavedEnds(w, { s, kind, body: kind === 'switch' ? SWITCH : undefined, rounds: 3,
      last: async sidX => assert.equal((await w.call(w.I2, 'logout', { sid: sidX })).status, 204) }));
    assert.deepEqual([out.status, out.cookie, await w.version(sid), await endsOf(w, s)],
      [kind === 'switch' ? 200 : 204, kind === 'switch' ? 'P' : 'K', null, [['auth.logout', 'logout', A]]], kind);
  }
  await w.finish('AS-12 T9');
});

test('AS-12 T10 (RT-06, X-25): a logout read v1 (A); v2 (B) is stored before its delete; it ends v2 and retains DB institution A', async t => {
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
  assert.deepEqual([out.status, out.cookie, await w.version(sid), await endsOf(w, s)], [204, 'K', null, [['auth.logout', 'logout', A]]]);
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

test('AS-12 T12 (RT-09, X-29): R2 judged v1 idle and waits; R stored v2 (B) - (a) touched: R2 proceeds; (b) not yet: R2 ends v2, DB institution A', async t => {
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
        [401, EXPIRED, 'K', null, [['auth.session.expired', 'idle', A]]], '(b) exactly one idle row, institution B');
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
  await w.I2.service.onModuleInit();
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
  await w.I2.service.onModuleInit();
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
  await w.I2.service.onModuleInit();
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
  // D628 restores the waiting identity: proof and session allow guidance and logout, never protected work.
  const pending = await login(w, w.I1, await w.issue('e3', { sub: 'syn-sub-e3', groups: [] }));
  assert.ok(pending.done.newSid);
  assert.ok(pending.done.proof);
  const waiting = await w.call(w.I1, 'me', {sid:pending.done.newSid});
  assert.equal(waiting.status,403); assert.equal(waiting.body.code,'INSTITUTION_PENDING');
  assert.equal(typeof waiting.body.sessionId,'string');
  assert.equal((await w.call(w.I1,'get',{sid:pending.done.newSid})).status,403);
  assert.equal((await w.call(w.I1,'logout',{sid:pending.done.newSid})).status,204);
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
  assert.deepEqual(await endsOf(w, s), [['auth.logout', 'logout', A], ['auth.logout', 'logout', A]]);
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
  const callbackDecision = w.gate('I2', 'audit');
  const heldC = answerFlow(w, w.I2, begin, await w.issue(s + '-v2', { sub: s, groups: [A] }));
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(w.calls.filter(c => c === 'I2:tx.markRead').length, reads, 'the callback waits for the lock the Log out holds');
  gate.release();
  assert.equal((await held).status, 204);
  await callbackDecision.arrived();
  // The callback has observed the committed mark, outside its lock. Its own retry can only confirm the mark
  // once the older Log out request has a known answer too (C10); arrange that answer before asking for a redirect.
  await w.until('older logout request acknowledged',async()=>
    (await w.base.providerChange.findFirst({where:{kind:'end_session',target:idpOf(s)},orderBy:{id:'asc'}}))?.state==='done');
  callbackDecision.release();
  const blocked = await heldC;
  assert.deepEqual([blocked.newSid, blocked.cookie, atProvider(blocked), await w.base.authSession.count({ where: { sub: s } })], [null, 'P', true, 0], blocked.location);
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
  await restarted.service.onModuleInit();
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
  await restarted.service.onModuleInit();
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


// Commander decisions on SEA-F08 (fix round 1): the isolation's marks are a recorded fact - re-activating the member
// (approval change, cancel, Activate) does not reopen a provider session the isolation listed. Integration round 6 (A):
// the login path reads no provider state at all - the member's isolation is our own fact (MemberIsolation).


// Integration round 6 (A): the reviewers' counter-example to "an unreadable member state lets the login through" -
// the disable succeeded, the session listing failed, nothing was marked, the state read fails, and a code exchanged
// before the isolation passes. The rule now: the isolation FIRST writes our own durable fact, THEN does the provider work;
// the callback and the refresh read only that fact; the retry cycle finishes unfinished provider work from the fact; only
// a finished re-activation removes it. Every interleaving the reviewers named makes no session.


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


// Integration review F04 (b): an administrator's Activate runs while the retry cycle is inside the isolation's provider
// work (held after it listed the member's provider sessions). The re-activation finishes the owed work itself, enables
// the member and clears the fact; the member logs in again. The cycle, when it goes on, must not disable the member,
// log the member out or end the new session after that Activate.
// On the stand-in the hold is the harness gate on the cycle's store transaction (not a lock), so the order is the same
// on both; the assertion is not vacuous there.


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
  // Complete the refused-transport stage before making the provider reachable. Unknown old sends are tested
  // separately and intentionally prevent confirmation even after a later successful retry.
  await w.told();
  await w.until('refused transport attempts recorded',async()=>
    await w.base.providerChange.count({where:{kind:'end_session',target:X,state:'unknown'}})===0);
  kc.logoutMode = 'ok';
  w.tick(1000);
  const resumer = w.instance('R21');
  await resumer.service.onModuleInit();
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
  await sweeper.service.onModuleInit();
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


// S7-U5 D600 decisive case 2: the old disable's effect is held past the product's wait and past a re-read of the provider's
// state (which still says the member is enabled - the disable has not been carried out). The only correct answer within 15 s
// is 409 ACTIVATION_UNCONFIRMED with the isolation kept. Then the effect is released and the member is disabled at the
// provider: an implementation that had answered success would now have a cleared isolation and a disabled member; this one
// still holds the isolation, and once that call has its own answer the next Activate leaves the member enabled for good.


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
  await retry.service.onModuleInit();
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


// S7-U5 D600 decisive case 5: the opposite side, and the latest command.
//   a. The admin API freezes while an isolation's disable is in flight. An unrelated doctor's login, refresh and Log out
//      go through without waiting for it (they never ask the admin API; the Log out's provider end waits in the background),
//      and the isolated member's login is refused at once from our own fact - no store lock is held across the provider call.
//   b. An Activate's enable is held; a new Suspend arrives before the Activate completes. The old Activate cannot clear the
//      new isolation (its generation is gone) nor leave the member active: it answers a conflict, the member stays isolated
//      here, and the retry cycle - once the late enable has its own answer - disables the member and finishes.


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

test('U1 HTTP-OUTCOMES: DELETE non-204 2xx, 404, final 401, other 4xx, 501 and uncertain 5xx', async t => {
  const w = await world(t);
  for (const kind of ['end_session']) for (const status of [200, 202, 204, 404, 401, 403, 409, 501, 502, 504]) {
    const m = r10Member('syn-u1-' + kind + status), P = m + '-idp';

      kc.afterEnd = () => status;
      const sid = await w.session(await w.issue(m, { sub: m, idp: P }));
      assert.equal((await w.call(w.I1, 'logout', { sid })).status, 204); await w.told();

    const state = status < 300 || (status === 404 && kind === 'end_session') ? 'done' : status < 500 || status === 501 ? 'void' : 'unknown';
    await w.until('HTTP outcome persisted', async () => (await w.base.providerChange.findFirst({ where: { sub: m, kind }, orderBy: { id: 'desc' } }))?.outcome != null);
    const changes = await w.base.providerChange.findMany({ where: { sub: m, kind } });
    assert.ok(changes.length > 0); assert.ok(changes.every(c => c.state === state), kind + ' ' + status + ': own response classification');
    assert.equal(!!(await w.mark(P))?.confirmedAt, state === 'done');
    kc.onAdmin = null; kc.afterEnd = null;
  }
  await w.finish('U1');
});

test('U2 401-THEN-CHANGE-503: the second mutation, not service-token acquisition, answers 503', async t => {
  const w = await world(t);
  for (const kind of ['end_session']) {
    const m = r10Member('syn-u2-' + kind), P = m + '-idp';

      kc.serviceMode = 'stale'; kc.afterEnd = () => '503';
      const sid = await w.session(await w.issue(m, { sub: m, idp: P }));
      await w.call(w.I2, 'logout', { sid }); await w.told();
      assert.equal((await w.mark(P)).confirmedAt, null);

    await w.until('second change 503 persisted', async () => (await w.base.providerChange.findFirst({ where: { sub: m, kind } }))?.outcome === 'http_503');
    assert.equal(await w.base.providerChange.count({ where: { sub: m, kind, state: 'unknown' } }), 1);
    kc.onAdmin = null; kc.afterEnd = null;
  }
  await w.finish('U2');
});

test('U3 HEADERS-TIMEOUT: provider effect with no headers reaches transport timeout and stays unknown', async t => {
  const w = await world(t);
  for (const kind of ['end_session']) {
    const m = r10Member('syn-u3-' + kind), P = m + '-idp';
    const held = holdEnd(P, 'after');
    kc.transportTimeoutMs = 250;
    let run;
    run = w.call(w.I1, 'logout', { sid: await w.session(await w.issue(m, { sub: m, idp: P })) });
    await held.arrived();
    assert.equal(kc.ended.includes(P), true, 'effect precedes missing headers');
    await run;
    await w.until('transport failure persisted', async () => (await w.base.providerChange.findFirst({ where: { sub: m, kind } }))?.outcome != null);
    assert.equal((await w.base.providerChange.findFirst({ where: { sub: m, kind } }))?.outcome, 'transport');
    held.release(); kc.transportTimeoutMs = 0; await quiet(w);
    assert.equal(await w.base.providerChange.count({ where: { sub: m, kind, state: 'unknown' } }), 1, 'late inaccessible response cannot settle the call');
    assert.equal((await w.mark(P)).confirmedAt, null);
  }
  await w.finish('U3');
});

test('U4 CRASH-CUTS: sid end records preserve recorded uncertainty across store/send/settle cuts and second-instance recovery', async t => {
  const w = await world(t);
  for (const kind of ['end_session']) {
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
      if (cut === 'before-effect' || cut === 'after-effect') effect = holdEnd(P, cut === 'before-effect' ? 'before' : 'after');
      const sent = kc.endRequests.length + kc.adminCalls.filter(c => c.startsWith('PUT ')).length;
      let run;
      run = w.call(w.I1, 'logout', { sid: await w.session(await w.issue(m, { sub: m, idp: P })) });
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
          assert.equal((await w.mark(P)).confirmedAt, null);
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
  await retry.service.onModuleInit(); await held.arrived();
  pending.release(); await w.told(); await w.until('confirmed', async () => !!(await w.mark(P))?.confirmedAt);
  w.tick(1000); kc.ended = [];
  const entered = (await login(w, w.I2, await w.issue(m + '-new', { sub: m, idp: P, authTime: Date.now() / 1000 }))).done;
  assert.ok(entered.newSid); const calls = kc.endRequests.length;
  held.release(); await quiet(w); retry.service.onModuleDestroy();
  assert.equal(kc.endRequests.length, calls); await r10Survives(w, m, P, entered, m);
  await w.finish('U5');
});

test('U9 UNKNOWN-GC-13H: old terminal records are collected; old unknown records and blocking survive', async t => {
  const w = await world(t), m = r10Member('syn-u9'), P = m + '-idp', at = new Date(Date.now() - 14 * HOUR);
  // A persisted call from a process no longer present: explicit storage fixture for restart/GC, not a provider answer.
  const unknown = await w.base.providerChange.create({ data: { sub: m, kind: 'end_session', target: P, generation: 1, state: 'unknown', createdAt: at } });
  for (const state of ['done', 'void']) await w.base.providerChange.create({ data: { sub: m, kind: 'end_session', target: P, generation: 1, state, createdAt: at, settledAt: at } });
  await w.base.idpSessionEnd.create({ data: { idpSid: P, cause: 'logout', decidedAt: at, nextAttemptAt: new Date(Date.now() + 2 * HOUR) } });
  const sweeper = w.instance('U9gc'); await sweeper.service.onModuleInit(); w.tick(HOUR);
  await w.until('terminal rows collected', async () => await w.base.providerChange.count({ where: {
    sub: m, state: { in: ['done', 'void'] }, createdAt: { lt: new Date(Date.now() - 13 * HOUR) },
  } }) === 0);
  sweeper.service.onModuleDestroy();
  assert.equal((await w.base.providerChange.findUnique({ where: { id: unknown.id } }))?.state, 'unknown');
  assert.equal((await w.mark(P)).confirmedAt, null);
  assert.equal((await login(w, w.I2, await w.issue(m, { sub: m, idp: P }))).done.newSid, null);
  await w.finish('U9');
});

// REQ-S7-U5-DB-RIGHTS -> RISK-STALE-CREDENTIAL / LOST-REVOCATION -> CORE tests, D621/D623.
async function coreMember(w, sub) {
  r10Member(sub); kc.members[sub].emailVerified = true;
  const token = await w.issue(sub, { sub, authTime: Math.floor(Date.now()/1000) });
  return { token, sid: await w.session(token), admin: r10Admin(w) };
}
async function coreFresh(w, sub, groups = [A]) {
  const rights = await w.base.memberRights.findUnique({where:{sub}});
  const old = await w.issue(sub+'-old', { sub, groups, authTime: Math.floor(rights.newAuthAfter.getTime()/1000) });
  const first = await login(w, w.I2, old);
  assert.equal(first.done.newSid, null, 'authentication at the boundary cannot enter');
  assert.equal(promptOf(first.done), 'login');
  w.tick(1000);
  const token = await w.issue(sub+'-fresh', { sub, groups, authTime: Math.floor(Date.now()/1000) });
  const done = await answerFlow(w, w.I2, first.done, token);
  assert.ok(done.newSid, 'nonce/state/PKCE-bound fresh authentication enters');
  return { token, done };
}

test('R10-05 DB block alone refuses every entry including a surviving session; logout remains allowed', async t => {
  const w = await world(t), m = 'syn-core-r1005', {token,sid,admin} = await coreMember(w,m);
  const old = await w.base.authSession.findUnique({where:{sid}});
  assert.equal((await r10Patch(admin,m,{enabled:false})).status,200);
  // A legacy leftover is deliberately restored: refusal must not depend on deletion succeeding in a past version.
  await w.base.authSession.create({data:old});
  const start=performance.now(); await r10Refuses(w,m,token,sid,'blocked');
  for(const kind of ['me','authz']) assert.notEqual((await w.call(w.I2,kind,{sid})).status,200,kind);
  assert.ok(performance.now()-start<2000,'no remote wait on refused entry');
  assert.equal((await w.call(w.I2,'logout',{sid})).status,204);
  await w.finish('R10-05');
});

test('U5E-15 Suspend/Activate require fresh authentication and never restore old rights', async t => {
  const w=await world(t), m='syn-core-u5e15', {token,sid,admin}=await coreMember(w,m);
  assert.equal((await r10Patch(admin,m,{enabled:false})).status,200);
  assert.equal((await w.call(w.I2,'get',{bearer:token.access})).status,401);
  assert.equal((await login(w,w.I2,token)).done.newSid,null);
  assert.equal((await r10Patch(admin,m,{enabled:true})).status,200);
  assert.equal((await w.call(w.I1,'get',{sid})).status,401);
  assert.equal((await w.call(w.I1,'get',{bearer:token.access})).status,401);
  const fresh=await coreFresh(w,m);
  assert.equal((await w.call(w.I2,'me',{sid:fresh.done.newSid})).status,200);
  await quiet(w);
  assert.equal(await w.base.providerChange.count({where:{sub:m,kind:'credentials'}}),0,'Suspend/Activate record no roster write');
  assert.ok(!kc.adminCalls.some(x => /enable|disable|sessions|logout/.test(x)),'no B01-B08 work');
  assert.equal(kc.endRequests.length,0);
  await w.finish('U5E-15');
});

test('CORE-A-B a callback held across Change and its old A Bearer cannot acquire B rights',async t=>{
  const w=await world(t),m='syn-core-ab',{token,admin}=await coreMember(w,m);
  const begin=await w.call(w.I1,'login'), hold=w.gate('I1','tx.open');
  const pending=answerFlow(w,w.I1,begin,token); await hold.arrived();
  assert.equal((await r10Patch(r10Admin(w,w.I2),m,{institution:B,roles:['clinician']})).status,200);
  hold.release(); assert.equal((await pending).newSid,null,'callback rechecks version inside creation transaction');
  assert.equal((await w.call(w.I2,'get',{bearer:token.access})).status,401,'old A Bearer cannot upgrade to B');
  const fresh=await coreFresh(w,m,[A]); // provider roster may still be A; identity never supplies rights.
  const me=await w.call(w.I2,'me',{sid:fresh.done.newSid});
  assert.equal(me.status,200); assert.equal(me.body.institution,B); assert.deepEqual(me.body.roles,['clinician']);
  assert.equal((await w.call(w.I2,'me',{bearer:fresh.token.access})).status,200);
  const other=await w.issue('same-auth-other-token',{sub:m,groups:[A],authTime:Math.floor(Date.now()/1000)});
  assert.equal((await w.call(w.I1,'me',{bearer:other.access})).status,200,'a later interactive token does not need a BFF session');
  await w.finish('CORE-A-B');
});

test('CORE-CAS two admin connections observe one version: exactly one commits, loser 409, sessions stay ended',async t=>{
  const w=await world(t),m='syn-core-cas',{admin}=await coreMember(w,m);
  const firstRead=w.pause({inst:'I1',model:'memberRights',method:'findUnique',scope:'root',phase:'after'});
  const secondRead=w.pause({inst:'I2',model:'memberRights',method:'findUnique',scope:'root',phase:'after'});
  const one=r10Patch(admin,m,{enabled:false}),two=r10Patch(r10Admin(w,w.I2),m,{approvalState:'PENDING'});
  await firstRead.arrived(); await secondRead.arrived();
  const held=w.pause({inst:'I1',model:'memberRights',method:'updateMany',scope:'tx',phase:'after'});
  const started=deferred(),pids=[];
  w.observe({model:'$transaction',phase:'started'},async e=>{
    if(!process.env.KIN_AUTH_SESSION_DATABASE_URL.includes('local-stand-in')){
      const rows=await e.client.$queryRawUnsafe('SELECT pg_backend_pid() AS pid'); pids.push(rows[0].pid);
    }
    if(e.inst==='I2')started.resolve();
  });
  firstRead.release(); await held.arrived(); secondRead.release();
  if(!process.env.KIN_AUTH_SESSION_DATABASE_URL.includes('local-stand-in'))await within(started.promise,'second PostgreSQL transaction starts');
  held.release(); const out=await Promise.all([one,two]);
  assert.deepEqual(out.map(v=>v.status).sort(),[200,409]);
  if(pids.length) assert.ok(new Set(pids).size>=2,'independent PostgreSQL connections overlap');
  const current=await w.base.memberRights.findUnique({where:{sub:m}});
  assert.equal(current.version,2); assert.equal(current.suspended,true);
  assert.equal(await w.base.authSession.count({where:{sub:m}}),0);
  assert.equal(kc.endRequests.length,0);
  await w.finish('CORE-CAS');
});

test('CORE-R1 a command held after commit cannot end a session admitted by a later Activate',async t=>{
  const w=await world(t),m='syn-core-r1',{admin}=await coreMember(w,m);
  const hold=w.pause({inst:'I1',model:'$transaction',phase:'after'},e=>e.result?.after?.id===m);
  const pending=r10Patch(admin,m,{enabled:false}); await hold.arrived();
  assert.equal((await r10Patch(r10Admin(w,w.I2),m,{enabled:true})).status,200);
  const fresh=await coreFresh(w,m); const row=await w.base.authSession.findUnique({where:{sid:fresh.done.newSid}});
  hold.release(); assert.equal((await pending).status,200);
  assert.deepEqual(await w.base.authSession.findUnique({where:{sid:fresh.done.newSid}}),row,'no work remains after old commit');
  assert.equal(kc.endRequests.length,0); await r10Survives(w,m,fresh.token.idp,fresh.done,m);
  await w.finish('CORE-R1');
});

test('CORE-COMMIT success waits for commit; deletion and audit failures roll the complete command back',async t=>{
  const w=await world(t),m='syn-core-commit',{sid,admin}=await coreMember(w,m);
  for(const point of ['tx.delete','tx.audit']){
    const before=await w.base.memberRights.findUnique({where:{sub:m}});
    w.fault('I1',point,new Error('synthetic command failure'));
    assert.equal((await r10Patch(admin,m,{enabled:false})).status,500);
    assert.deepEqual(await w.base.memberRights.findUnique({where:{sub:m}}),before);
    assert.ok(await w.base.authSession.findUnique({where:{sid}}));
  }
  const hold=w.pause({inst:'I1',model:'auditLog',method:'create',scope:'tx',phase:'after'},e=>e.args.data.action==='admin.user.suspend');
  let returned=false; const pending=r10Patch(admin,m,{enabled:false}).then(v=>{returned=true;return v;});
  await hold.arrived(); await delay(30); assert.equal(returned,false,'no success before commit');
  assert.equal((await w.base.memberRights.findUnique({where:{sub:m}})).suspended,false,'uncommitted change is invisible');
  hold.release(); assert.equal((await pending).status,200);
  assert.equal((await w.base.memberRights.findUnique({where:{sub:m}})).suspended,true);
  await w.finish('CORE-COMMIT');
});

test('CORE-COOKIE member revoked while signature verification is held cannot enter from the saved session',async t=>{
  const w=await world(t),m='syn-core-cookie',{sid,admin}=await coreMember(w,m);
  const arrived=deferred(),release=deferred(),verify=w.I2.service.verifyAccessToken.bind(w.I2.service);
  w.I2.service.verifyAccessToken=async raw=>{const p=await verify(raw);arrived.resolve();await release.promise;return p;};
  const run=w.call(w.I2,'get',{sid});await within(arrived.promise,'verified identity');
  assert.equal((await r10Patch(admin,m,{enabled:false})).status,200);release.resolve();
  assert.equal((await run).status,401);await w.finish('CORE-COOKIE');
});

test('CORE-PROOF proof consumption rechecks DB state inside its transaction',async t=>{
  const w=await world(t),m='syn-core-proof';await coreMember(w,m);
  const done=(await login(w,w.I1,await w.issue(m+'-proof',{sub:m}))).done;
  const hold=w.gate('I2','tx.open'),run=w.call(w.I2,'entry',{sid:done.newSid,body:{proof:done.proof}});await hold.arrived();
  await w.base.memberRights.update({where:{sub:m},data:{suspended:true,version:{increment:1},newAuthAfter:new Date()}});
  hold.release();assert.notEqual((await run).status,200);
  assert.ok((await w.base.authSession.findUnique({where:{sid:done.newSid}})).entryProofHash,'proof remains unconsumed');
  assert.equal((await w.rows()).filter(r=>r.action==='auth.entry').length,0);await w.finish('CORE-PROOF');
});

test('CORE-REFRESH member is checked before provider exchange and again before storing the answer',async t=>{
  const w=await world(t),m='syn-core-refresh',{sid}=await coreMember(w,m);
  await w.base.authSession.update({where:{sid},data:{atExpiresAt:lapsed()}});
  const hold=w.pause({inst:'I2',model:'memberRights',method:'findUnique',scope:'root',phase:'after'});
  const run=w.call(w.I2,'get',{sid});await hold.arrived();
  await w.base.memberRights.update({where:{sub:m},data:{suspended:true}});hold.release();
  assert.equal((await run).status,401);assert.equal(kc.tokens,0,'blocked refresh must not be exchanged');
  await w.base.memberRights.update({where:{sub:m},data:{suspended:false}});
  const next=await w.issue(m+'-next',{sub:m}),run2=w.call(w.I1,'get',{sid});const exchange=await heldToken(1,'I1');
  const before=await w.base.authSession.findUnique({where:{sid}});
  await w.base.memberRights.update({where:{sub:m},data:{version:{increment:1},newAuthAfter:new Date()}});
  exchange.answer(reply.tokens(next));assert.notEqual((await run2).status,200);
  assert.equal((await w.base.authSession.findUnique({where:{sid}})).accessToken,before.accessToken,'late tokens cannot be stored');
  await w.finish('CORE-REFRESH');
});

test('CORE-MISSING missing DB rights and DB read failures never fall back to JWT roles',async t=>{
  const w=await world(t),m='syn-core-missing',{token,sid}=await coreMember(w,m);
  // A missing row models an unimported realm member. TRUNCATE is confined to this disposable fixture.
  await w.base.$executeRawUnsafe('TRUNCATE "MemberRights"');
  assert.equal((await w.call(w.I1,'get',{bearer:token.access})).status,403);
  assert.equal((await w.call(w.I1,'get',{sid})).status,401);
  let once=true;w.observe({model:'memberRights',method:'findUnique',phase:'before'},()=>{if(once){once=false;throw new Error('synthetic database unavailable');}});
  assert.equal((await w.call(w.I1,'get',{bearer:token.access})).status,500);
  await w.finish('CORE-MISSING');
});

test('CORE-CANCEL approval cancellation retains history and cannot be bypassed by Activate',async t=>{
  const w=await world(t),m='syn-core-cancel',{token,admin}=await coreMember(w,m);
  assert.equal((await r10Patch(admin,m,{approvalState:'PENDING'})).status,200);
  const row=await w.base.memberRights.findUnique({where:{sub:m}});
  assert.deepEqual([row.approved,row.suspended,row.institution,row.roles,row.version],[false,true,null,[],2]);
  assert.ok(row.newAuthAfter);assert.equal((await r10Patch(admin,m,{enabled:true})).status,400);
  assert.equal((await w.call(w.I1,'get',{bearer:token.access})).status,401);
  assert.equal((await r10Patch(admin,m,{approvalState:'APPROVED',institution:B,roles:['radiologist'],enabled:true})).status,200);
  assert.equal((await w.base.memberRights.findUnique({where:{sub:m}})).version,3);
  assert.equal((await w.call(w.I1,'get',{bearer:token.access})).status,401);
  const fresh=await coreFresh(w,m,[A]);assert.equal((await w.call(w.I2,'me',{sid:fresh.done.newSid})).body.institution,B);
  await w.finish('CORE-CANCEL');
});

// D627: REQ-S7-U5-DB-RIGHTS -> RISK-STALE-CREDENTIAL / RISK-S7-U5-CROSS-INSTITUTION
// -> CORE-IMPORT / CORE-R2-BOOT: one atomic import boundary, compatible cookie continuity.
test('CORE-IMPORT all imported members share a commit boundary; old Bearers fail, compatible cookies and fresh DB rights enter', async t => {
  const w = await world(t, {imported:false}), {importMemberRights} = require('/app/dist/member-rights-import');
  const oldTime = Math.floor(Date.now() / 1000);
  const a = await w.issue('import-a', {sub:'syn-import-a', authTime:oldTime}), sid = await w.session(a);
  const bad = await w.issue('import-bad', {sub:'syn-import-bad', authTime:oldTime}), badSid = await w.session(bad);
  const users = ['syn-import-a','syn-import-bad','syn-import-no-session','syn-import-disabled','syn-import-unknown'].map(sub => ({
    id:sub, username:sub, email:sub+'@synthetic.test', emailVerified:true, firstName:'Synthetic', lastName:'Member',
    enabled:sub !== 'syn-import-disabled', serviceAccountClientId:null, groups:sub === 'syn-import-bad' ? [B] : [A], roles:['radiologist']}));
  const oldTokens = [a, bad];
  for (const user of users.slice(2)) oldTokens.push(await w.issue(user.id+'-old', {sub:user.id, authTime:oldTime}));
  await w.base.$executeRawUnsafe('TRUNCATE "MemberRights"');
  const unknown = await w.base.providerChange.create({data:{kind:'disable',sub:'syn-import-unknown',target:'syn-import-unknown',generation:1,state:'unknown',createdAt:new Date()}});
  // Advance the clock across real store operations: the decision must cover the whole import,
  // not page-fetch time, transaction start or a different instant for each member.
  w.observe({inst:'I1', scope:'tx', model:'memberRights', method:'upsert', phase:'after'}, () => w.tick(1100));
  const provider = {listUsers:async page => ({total:users.length, users:users.slice((page-1)*2,page*2)})};
  await importMemberRights(w.I1.prisma, provider);
  assert.equal(await w.base.memberRights.count(), 5, 'member without session also has a row');
  assert.equal(await w.base.idpSessionEnd.count(), 0, 'refusal must not depend on an ended-SSO mark');
  const cookie = await w.call(w.I1, 'get', {sid});
  assert.equal(cookie.status, 200, 'compatible legacy session keeps working');
  assert.equal(cookie.location, null, 'no login prompt or redirect for the compatible cookie');
  assert.equal(cookie.newSid, null, 'no replacement session is required');
  assert.equal((await w.base.authSession.findUnique({where:{sid}})).rightsVersion,
    (await w.base.memberRights.findUnique({where:{sub:a.sub}})).version);
  assert.equal((await w.base.authSession.findUnique({where:{sid:badSid}})).rightsVersion, 0);
  assert.equal((await w.call(w.I1, 'get', {sid:badSid})).status, 401, 'old A session never becomes B');
  for (const token of oldTokens) {
    const out = await w.call(w.I1, 'get', {bearer:token.access});
    assert.equal(out.status, 401, token.label+': the same old token cannot gain imported rights through Bearer');
    assert.equal(out.body.code, 'AUTH_SESSION_ENDED');
  }
  const marker = await w.base.memberRightsImport.findUnique({where:{id:'realm-v1'}});
  assert.equal(marker.completedAt.getTime(), Date.now(), 'import decision time is after the last member, not its first row');
  for (const row of await w.base.memberRights.findMany())
    assert.equal(row.newAuthAfter?.getTime(), marker.completedAt.getTime(), 'every imported row shares the committed decision time');
  const importSecond = Math.floor(marker.completedAt.getTime() / 1000);
  for (const user of users) {
    const token = await w.issue(user.id+'-same', {sub:user.id, groups:user.groups, authTime:importSecond});
    const out = await w.call(w.I2, 'get', {bearer:token.access});
    assert.equal(out.status, 401, 'matching claims at the import second are still refused');
    assert.equal(out.body.code, 'AUTH_SESSION_ENDED');
  }
  w.tick(1000);
  for (const user of users) {
    // Fresh A/technician claims deliberately differ: the DB remains the authority after admission.
    const token = await w.issue(user.id+'-fresh', {sub:user.id, groups:[A], roles:['technician'], authTime:importSecond+1});
    const out = await w.call(w.I2, 'me', {bearer:token.access});
    const blocked = ['syn-import-disabled','syn-import-unknown'].includes(user.id);
    assert.equal(out.status, blocked ? 401 : 200);
    if (blocked) assert.equal(out.body.code, 'AUTH_SESSION_ENDED');
    else {
      assert.equal(out.body.institution, user.groups[0]);
      assert.deepEqual(out.body.roles, ['radiologist']);
    }
  }
  assert.equal(await w.base.authSession.count({where:{sub:'syn-import-no-session'}}), 0, 'Bearer-only member needs no cookie session');
  assert.equal(kc.tokens, 0, 'import and cookie continuity require no provider authentication');
  for (const sub of ['syn-import-disabled','syn-import-unknown']) assert.equal((await w.base.memberRights.findUnique({where:{sub}})).suspended, true);
  assert.equal((await w.base.providerChange.findUnique({where:{id:unknown.id}})).state, 'unknown');
  await w.base.memberRights.update({where:{sub:'syn-import-a'},data:{version:4,newAuthAfter:new Date(),suspended:true}});
  const retained = await w.base.memberRights.findMany({orderBy:{sub:'asc'}});
  await importMemberRights(w.base, {listUsers:() => {throw new Error('must not reimport authority');}});
  assert.deepEqual(await w.base.memberRights.findMany({orderBy:{sub:'asc'}}), retained, 'restart preserves the rights and their boundaries');
  assert.deepEqual(await w.base.memberRightsImport.findUnique({where:{id:'realm-v1'}}), marker);
  if (!process.env.KIN_AUTH_SESSION_DATABASE_URL.includes('local-stand-in')) {
    await assert.rejects(w.base.memberRights.delete({where:{sub:'syn-import-a'}}));
    await assert.rejects(w.base.memberRights.update({where:{sub:'syn-import-a'},data:{version:1}}));
  }
  await w.finish('CORE-IMPORT');
});

test('CORE-ROSTER unknown credential outcomes never block DB commands or fresh entry',async t=>{
  const w=await world(t),m='syn-core-roster',{admin}=await coreMember(w,m);
  const arrived=deferred(),release=deferred();let once=true;
  kc.beforeAdmin=(name,sub)=>{if(once&&sub===m&&name.startsWith('PUT groups/')){once=false;arrived.resolve();return release.promise;}};
  t.after(()=>release.resolve('drop'));
  const changed=await r10Patch(admin,m,{institution:B,roles:['radiologist']});assert.equal(changed.status,200);
  await within(arrived.promise,'credential write held before its effect');
  const change=await w.base.providerChange.findFirst({where:{kind:'credentials',sub:m}});
  assert.equal(change.state,'unknown','intent is committed before send');
  assert.equal((await r10Patch(r10Admin(w,w.I2),m,{enabled:false})).status,200);
  assert.equal((await r10Patch(r10Admin(w,w.I2),m,{enabled:true})).status,200);
  const fresh=await coreFresh(w,m,[A]);assert.equal((await w.call(w.I2,'me',{sid:fresh.done.newSid})).body.institution,B);
  release.resolve('drop');await w.until('credential unknown outcome recorded',async()=>!!(await w.base.providerChange.findUnique({where:{id:change.id}})).outcome);
  assert.equal((await w.base.providerChange.findUnique({where:{id:change.id}})).state,'unknown');
  assert.equal((await w.base.memberRights.findUnique({where:{sub:m}})).suspended,false);
  assert.equal(kc.endRequests.length,0);await w.finish('CORE-ROSTER');
});

test('CORE-NONCE old authentication cannot enter a new version through a mismatched nonce or an old auth_time',async t=>{
  const w=await world(t),m='syn-core-nonce',{token,admin}=await coreMember(w,m);
  w.tick(2000);assert.equal((await r10Patch(admin,m,{institution:B,roles:['radiologist']})).status,200);
  const first=(await login(w,w.I2,token)).done;assert.equal(first.newSid,null);assert.equal(promptOf(first),'login');
  const old=await answerFlow(w,w.I2,first,token);assert.equal(old.newSid,null,'fresh flow does not admit an old authentication time');
  const flow=(await login(w,w.I2,token)).done;
  w.tick(1000);
  const fresh=await w.issue(m+'-wrong-nonce',{sub:m,authTime:Math.floor(Date.now()/1000)});
  const wrong=await answerFlow(w,w.I2,flow,fresh,{nonce:'different-authentication'});
  assert.equal(wrong.newSid,null,'a fresh authentication with another nonce is not admitted');
  const good=await coreFresh(w,m);assert.ok(good.done.newSid);await w.finish('CORE-NONCE');
});


test('CORE-LOGOUT-ORDER provider sees only committed revocation and its audit',async t=>{
  const w=await world(t),m='syn-core-logout-order';const {sid}=await coreMember(w,m);
  const told=deferred();kc.logoutMode='ok';
  kc.onLogout=async()=>told.resolve({session:await w.version(sid),rows:await endsOf(w,m)});
  const out=await w.call(w.I1,'logout',{sid});assert.equal(out.status,204);
  assert.deepEqual(await within(told.promise,'provider observed committed logout'),
    {session:null,rows:[['auth.logout','logout',A]]},'remote logout never precedes product commit');
  await w.finish('CORE-LOGOUT-ORDER');
});

// REQ-S7-U5-DB-RIGHTS -> RISK-PARTIAL-IMPORT / STALE-SSO / READ-MUTATION -> CORE-R2.
test('CORE-R2-BOOT API starts during realm outage; retries indefinitely with capped backoff; admission waits for atomic import', async t => {
  const w=await world(t,{imported:false}),m='syn-r4-boot';
  const old=await w.issue(m,{sub:m,authTime:Math.floor(Date.now()/1000)});
  const sid=await w.session(old);
  const queued=[],delays=[],realTimer=global.setTimeout;
  t.after(()=>{global.setTimeout=realTimer;});
  let calls=0,active=0,maxActive=0,failedCommit=false,tx;
  const user={id:m,username:m,email:m+'@synthetic.test',emailVerified:true,enabled:true,groups:[A],roles:['radiologist'],firstName:'SYN',lastName:'BOOT'};
  const provider={listUsers:async(page,signal)=>{
    calls++;active++;maxActive=Math.max(maxActive,active);
    try {
      assert.ok(signal instanceof AbortSignal);
      if(calls<=7)throw new Error('synthetic realm unreachable');
      if(calls===8)return {total:2,users:[user]};
      if(calls===9)throw new Error('synthetic second page unreadable');
      return {total:1,users:[user]};
    }finally{active--;}
  }};
  w.observe({inst:'I1',model:'$transaction',phase:'started'},e=>{tx=e.client;});
  w.observe({inst:'I1',scope:'tx',model:'memberRightsImport',method:'create',phase:'after'},async e=>{
    if(failedCommit)return;
    assert.equal((await tx.memberRights.findUnique({where:{sub:m}})).newAuthAfter.getTime(),e.result.completedAt.getTime());
    assert.equal(await w.base.memberRightsImport.count(),0,'marker invisible before commit');
    failedCommit=true;throw new Error('synthetic failure after marker before commit');
  });
  const service=new AuthService(w.I1.prisma,provider); t.after(()=>service.onModuleDestroy());
  // Only the import scheduler is controlled: no network/readiness sleeps are elided.
  const schedule=()=>{global.setTimeout=(fn,ms,...args)=>{if(![1000,2000,4000,8000,16000,30000].includes(ms))return realTimer(fn,ms,...args);delays.push(ms);queued.push(fn);return {unref(){}};};};
  const flush=async()=>{for(let i=0;i<100;i++)await new Promise(resolve=>setImmediate(resolve));};
  schedule();
  try {
    let started=false,startError;
    const start=service.onModuleInit().then(()=>{started=true;},e=>{startError=e;});
    await flush();
    assert.equal(startError,undefined);assert.equal(started,true,'realm failure must never refuse or delay API startup');
    await start;
  }finally{ /* Scheduler stays controlled until the asynchronous DB attempt finishes. */ }
  await w.until('first attempt settles',async()=>queued.length>0||capture.texts.some(([,line])=>line.includes('import attempt 1: ready')));
  assert.equal(queued.length,1,'failed import must schedule its retry');
  assert.deepEqual((await w.call(w.I1,'health')).body.memberRights,'pending');
  assert.equal((await w.call(w.I1,'health')).status,200);
  assert.equal((await w.call(w.I1,'get',{sid})).status,401,'even preexisting member rows cannot enter before marker');
  assert.equal((await login(w,w.I1,old)).done.newSid,null);
  for(let i=0;i<9;i++){
    assert.equal(queued.length,1,'one retry in flight');
    queued.shift()();await flush();
    await w.until('attempt settled',async()=>queued.length===1||!!await w.base.memberRightsImport.findUnique({where:{id:'realm-v1'}}));
    if(i<8)assert.equal(await w.base.memberRightsImport.count(),0);
  }
  assert.deepEqual(delays,[1000,2000,4000,8000,16000,30000,30000,30000,30000]);
  global.setTimeout=realTimer;
  assert.equal(maxActive,1);assert.equal(failedCommit,true);assert.equal(calls,11);
  assert.equal((await w.call(w.I2,'health')).body.memberRights,'ready');
  assert.equal((await w.call(w.I1,'get',{bearer:old.access})).status,401);
  w.tick(1000);const fresh=await w.issue(m+'-fresh',{sub:m,authTime:Math.floor(Date.now()/1000)});
  assert.ok((await login(w,w.I2,fresh)).done.newSid);
  const restart=new AuthService(w.base,{listUsers:async()=>{calls++;throw Error('must skip provider');}});
  t.after(()=>restart.onModuleDestroy());await restart.onModuleInit();await flush();assert.equal(calls,11);
  const logs=await w.finish('CORE-R2-BOOT');
  assert.ok(logs.some(([,line])=>line.includes('synthetic realm unreachable')),'retry reason is logged');
});

test('CORE-R2-IMPORTED existing realm-v1 starts while the member admin API is down', async t => {
  const w=await world(t);let read=false,calls=0;
  w.observe({inst:'I1',scope:'root',model:'memberRightsImport',method:'findUnique',phase:'after'},()=>{read=true;});
  const service=new AuthService(w.I1.prisma,{listUsers:async()=>{calls++;throw Error('synthetic realm down');}});
  t.after(()=>service.onModuleDestroy());await service.onModuleInit();
  await w.until('import read or provider attempt completed',async()=>read||calls>0);
  // The stub fails synchronously, so draining this completed read's continuations settles the import attempt too.
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,0);assert.equal(kc.serviceTokens,0);
  service.onModuleDestroy();await w.finish('CORE-R2-IMPORTED');
});

test('CORE-R2-SSO authentication after Change enters plain login without another prompt or admin read', async t => {
  const w=await world(t),m='syn-r2-after',{admin}=await coreMember(w,m);
  assert.equal((await r10Patch(admin,m,{institution:B,roles:['clinician']})).status,200);
  await quiet(w); const calls=kc.adminCalls.length; kc.adminDown=true;
  w.tick(1000); const token=await w.issue(m+'-new',{sub:m,authTime:Math.floor(Date.now()/1000)});
  const begin=await w.call(w.I2,'login');
  assert.equal((await answerFlow(w,w.I2,begin,token,{nonce:'another-flow'})).newSid,null,'plain SSO must bind its nonce');
  const first=await login(w,w.I2,token);
  assert.ok(first.done.newSid,'plain login accepts the post-change SSO without prompt=login');
  assert.equal((await w.call(w.I2,'me',{sid:first.done.newSid})).body.institution,B);
  assert.equal(kc.adminCalls.length,calls,'no admin request in login');
  await w.finish('CORE-R2-SSO');
});

test('CORE-R2-BOUNDARY older and same-second SSO redirect once; fresh after boundary enters', async t => {
  const w=await world(t),m='syn-r2-boundary',{token,admin}=await coreMember(w,m);
  w.tick(1000); assert.equal((await r10Patch(admin,m,{enabled:false})).status,200);
  assert.equal((await r10Patch(admin,m,{enabled:true})).status,200);
  const before=(await login(w,w.I2,token)).done;
  assert.equal(before.newSid,null); assert.equal(promptOf(before),'login');
  const same=await w.issue(m+'-same',{sub:m,authTime:Math.floor(Date.now()/1000)});
  assert.equal((await answerFlow(w,w.I2,before,same)).newSid,null,'fresh same-second authentication is refused');
  await coreFresh(w,m); await w.finish('CORE-R2-BOUNDARY');
});

test('CORE-R2-BEARER interactive grants after boundary need no product session; old, same, unusable time refused', async t => {
  const w=await world(t),m='syn-r2-bearer',{admin}=await coreMember(w,m);
  assert.equal((await r10Patch(admin,m,{enabled:false})).status,200);
  assert.equal((await r10Patch(admin,m,{enabled:true})).status,200);
  const boundary=Math.floor(Date.now()/1000); w.tick(1000);
  for(const [label,time,status] of [['before',boundary-1,401],['same',boundary,401],['after',boundary+1,200],
    ['missing',undefined,401],['null',null,401],['string',String(boundary+1),401]]) {
    const token=await w.issue(m+label,{sub:m,authTime:time});
    assert.equal((await w.call(w.I1,'me',{bearer:token.access})).status,status,label);
  }
  assert.equal(await w.base.authSession.count({where:{sub:m}}),0);
  await w.finish('CORE-R2-BEARER');
});

test('CORE-R2-LIST GET leaves rights unchanged; PATCH registers and approves atomically', async t => {
  const w=await world(t),m='syn-r2-unregistered'; r10Member(m); kc.members[m].emailVerified=true;
  const admin=r10Admin(w), before=await w.base.memberRights.count();
  const list=await admin.listUsers(1,{actor:'syn-admin',roles:['admin']});
  const shown=list.users.find(u=>u.id===m); assert.ok(shown);
  assert.equal(shown.approvalState,'PENDING'); assert.equal(shown.version,null); assert.equal(shown.rosterUnconfirmed,false);
  assert.equal(await w.base.memberRights.count(),before,'GET cannot register');
  w.fault('I1','tx.audit',new Error('synthetic audit failure'));
  assert.notEqual((await r10Patch(admin,m,{institution:A,roles:['radiologist'],verificationOverride:true})).status,200);
  assert.equal(await w.base.memberRights.count(),before,'registration rolls back with the failed command');
  const out=await r10Patch(admin,m,{institution:A,roles:['radiologist'],enabled:true,verificationOverride:true,version:null});
  assert.equal(out.status,200); assert.equal(out.user.approvalState,'APPROVED');
  assert.equal(await w.base.memberRights.count(),before+1);
  assert.equal((await r10Patch(admin,m,{enabled:false,version:null})).status,409,'existing row requires CAS');
  await w.finish('CORE-R2-LIST');
});

// D628 / REQ-S7-U5-DB-RIGHTS -> RISK-STALE-CREDENTIAL / PARTIAL-COMMIT / MISATTRIBUTED-END.
// U1–U13 enumerate independent decisions; PG runs use actual transaction/statement boundaries.
const CORE_COMMANDS=['Suspend','Approve','Change','Cancel','Activate'];
const coreBody=name=>({Suspend:{enabled:false},Approve:{approvalState:'APPROVED',institution:B,roles:['radiologist'],enabled:true},
  Change:{institution:B,roles:['technician']},Cancel:{approvalState:'PENDING'},Activate:{enabled:true}}[name]);
const realPG=()=>!process.env.KIN_AUTH_SESSION_DATABASE_URL.includes('local-stand-in');
async function coreSetup(w,m,command){
  const setup=await coreMember(w,m);
  if(command==='Approve')await w.base.memberRights.update({where:{sub:m},data:{approved:false,institution:null,roles:[]}});
  if(command==='Activate')await w.base.memberRights.update({where:{sub:m},data:{suspended:true}});
  return setup;
}
async function coreRoster(w,m){
  const out=await r10Admin(w).listUsers(1,R10_CALLER);return out.users.find(u=>u.id===m);
}
async function coreSettled(w,m){
  await w.until('recorded credentials settled',async()=>{
    const row=await w.base.providerChange.findFirst({where:{sub:m,kind:'credentials'},orderBy:{id:'desc'}});
    return row&&row.outcome;
  });
}

for(const first of CORE_COMMANDS)for(const second of CORE_COMMANDS){
  if(first==='Suspend'&&second==='Cancel')continue; // CORE-CAS covers this cell.
  test(`CORE_COMMAND_CAS_MATRIX U1 ${first}->${second}`,async t=>{
    const w=await world(t),m='syn-cas-'+first+'-'+second,{admin}=await coreMember(w,m);
    // Both requests observe a valid version. Approval is a full scope replacement even if already approved.
    const r1=w.pause({inst:'I1',model:'memberRights',method:'findUnique',scope:'root',phase:'after'});
    const r2=w.pause({inst:'I2',model:'memberRights',method:'findUnique',scope:'root',phase:'after'});
    const a=r10Patch(admin,m,coreBody(first)),b=r10Patch(r10Admin(w,w.I2),m,coreBody(second));
    await r1.arrived();await r2.arrived();
    const hold=w.pause({inst:'I1',model:'memberRights',method:'updateMany',scope:'tx',phase:'after'});
    const started=deferred(),pids=[];
    w.observe({model:'$transaction',phase:'started'},async e=>{
      if(realPG())pids.push((await e.client.$queryRawUnsafe('SELECT pg_backend_pid() AS pid'))[0].pid);
      if(e.inst==='I2')started.resolve();
    });
    r1.release();await hold.arrived();r2.release();if(realPG())await within(started.promise,'second command connection');
    hold.release();const results=await Promise.all([a,b]);
    assert.deepEqual(results.map(x=>x.status),[200,409],`${first}->${second}: only the first observed version commits`);
    if(realPG())assert.ok(new Set(pids).size>=2);
    assert.equal((await w.base.memberRights.findUnique({where:{sub:m}})).version,2);
    assert.equal(await w.base.authSession.count({where:{sub:m}}),0);
    const audits=await w.base.auditLog.findMany({where:{target:m}});
    assert.equal(audits.filter(r=>r.action.startsWith('admin.user.')&&!r.action.endsWith('.failed')).length,1);
    await quiet(w);assert.equal(kc.endRequests.length,0);await w.finish(`U1 ${first}->${second}`);
  });
}
for(const first of CORE_COMMANDS)for(const second of CORE_COMMANDS){
  if(first==='Suspend'&&second==='Activate')continue; // CORE-R1 covers this cell.
  test(`CORE_POSTCOMMIT_MATRIX U2 ${first}->${second}`,async t=>{
    const w=await world(t),m='syn-post-'+first+'-'+second,{admin}=await coreSetup(w,m,first);
    const pids=[];w.observe({model:'$transaction',phase:'started'},async e=>{
      if(realPG())pids.push((await e.client.$queryRawUnsafe('SELECT pg_backend_pid() AS pid'))[0].pid);
    });
    // The first connection remains occupied AFTER commit: this is a delayed response, never an open transaction.
    const hold=w.pause({inst:'I1',model:'$transaction',phase:'after'},e=>e.result?.after?.id===m);
    const old=r10Patch(admin,m,coreBody(first));await hold.arrived();
    let reserved,release;
    if(realPG()){
      const arrived=deferred();release=deferred();
      reserved=w.base.$transaction(async tx=>{pids.push((await tx.$queryRawUnsafe('SELECT pg_backend_pid() AS pid'))[0].pid);arrived.resolve();await release.promise;});
      await arrived.promise;t.after(()=>release.resolve());
      pids.push((await w.base.$queryRawUnsafe('SELECT pg_backend_pid() AS pid'))[0].pid);
    }
    const next=await r10Patch(r10Admin(w,w.I2),m,coreBody(second));
    const invalid=first==='Cancel'&&second==='Activate';
    assert.equal(next.status,invalid?400:200);
    release?.resolve();if(reserved)await reserved;
    if(realPG())assert.ok(new Set(pids).size>=2,'ordering is exercised across two PG connections');
    const current=await w.base.memberRights.findUnique({where:{sub:m}});
    w.tick(1000);const token=await w.issue(m+'-new',{sub:m,authTime:Math.floor(Date.now()/1000)});
    const fresh=(await login(w,w.I2,token)).done;
    const blocked=second==='Suspend'||second==='Cancel'||invalid||(second==='Change'&&['Suspend','Cancel'].includes(first));
    assert.equal(!!fresh.newSid,!blocked,'latest command alone decides entry');
    const snapshot=fresh.newSid?await w.base.authSession.findUnique({where:{sid:fresh.newSid}}):null;
    const admittedRights=await w.base.memberRights.findUnique({where:{sub:m}});
    for(const key of ['version','approved','suspended','institution','roles','newAuthAfter'])
      assert.deepEqual(admittedRights[key],current[key],'callback preserves '+key);
    hold.release();assert.equal((await old).status,200);await quiet(w);
    assert.deepEqual(await w.base.memberRights.findUnique({where:{sub:m}}),admittedRights,'late roster never changes rights or identity');
    if(snapshot){
      assert.deepEqual(await w.base.authSession.findUnique({where:{sid:fresh.newSid}}),snapshot);
      assert.equal((await w.call(w.I2,'me',{sid:fresh.newSid})).body.institution,current.institution);
    }else assert.equal((await w.call(w.I2,'get',{bearer:token.access})).status,401);
    assert.equal(kc.endRequests.length,0);await w.finish(`U2 ${first}->${second}`);
  });
}
for(const command of ['Approve','Change','Cancel','Activate'])test(`CORE_COMMAND_ATOMIC_AUDIT U3 ${command}`,async t=>{
  const w=await world(t),m='syn-atomic-'+command,{admin,sid}=await coreSetup(w,m,command);
  const before=await w.base.memberRights.findUnique({where:{sub:m}});
  for(const failure of ['authSession','auditLog','providerChange']){
    if(failure==='providerChange'&&['Cancel','Activate'].includes(command))continue;
    let reached=false;
    w.observe({inst:'I1',scope:'tx',model:failure,method:failure==='authSession'?'deleteMany':'create',phase:'after'},()=>{
      if(!reached){reached=true;throw Error('synthetic atomic command failure');}
    });
    assert.equal((await r10Patch(admin,m,coreBody(command))).status,500);
    assert.equal(reached,true);assert.deepEqual(await w.base.memberRights.findUnique({where:{sub:m}}),before);
    assert.ok(await w.base.authSession.findUnique({where:{sid}}));
    assert.equal(await w.base.providerChange.count(),0);
    assert.equal((await w.base.auditLog.findMany({where:{target:m}})).filter(r=>!r.action.endsWith('.failed')).length,0);
    assert.ok(!kc.adminCalls.some(x=>/^(PUT|POST|DELETE) /.test(x)),'rollback sends nothing');
  }
  const hold=w.pause({inst:'I1',scope:'tx',model:'auditLog',method:'create',phase:'after'},e=>e.args.data.action.startsWith('admin.user.'));
  let returned=false;const run=r10Patch(admin,m,coreBody(command)).then(out=>{returned=true;return out;});await hold.arrived();
  assert.equal(returned,false);assert.deepEqual(await w.base.memberRights.findUnique({where:{sub:m}}),before);
  hold.release();assert.equal((await run).status,200);
  const after=await w.base.memberRights.findUnique({where:{sub:m}});
  const audit=(await w.base.auditLog.findMany({where:{target:m}})).find(r=>r.action.startsWith('admin.user.')&&!r.action.endsWith('.failed'));
  const detail=JSON.parse(audit.detail);
  assert.equal(detail.before.version,before.version);assert.equal(detail.after.version,after.version);
  assert.equal(detail.after.institution,after.institution);assert.deepEqual(detail.after.roles,after.roles);
  assert.equal(await w.base.authSession.count({where:{sub:m}}),0);await quiet(w);await w.finish('U3 '+command);
});
for(const command of CORE_COMMANDS)test(`CORE_COMMAND_READ_FAILURE U4 ${command}`,async t=>{
  const w=await world(t),m='syn-read-'+command,{admin,sid}=await coreSetup(w,m,command);
  const before=await w.base.memberRights.findUnique({where:{sub:m}});
  for(const scope of ['root','tx']){
    let reached=false;
    w.observe({inst:'I1',scope,model:'memberRights',method:'findUnique',phase:'before'},()=>{if(!reached){reached=true;throw Error('synthetic rights read down');}});
    assert.equal((await r10Patch(admin,m,coreBody(command))).status,500);assert.equal(reached,true);
    assert.deepEqual(await w.base.memberRights.findUnique({where:{sub:m}}),before);
    assert.ok(await w.base.authSession.findUnique({where:{sid}}));assert.equal(await w.base.providerChange.count(),0);
    assert.ok(!kc.adminCalls.some(x=>/^(PUT|POST|DELETE) /.test(x)));
  }
  await w.finish('U4 '+command);
});

async function coreEntry(w,path,m){
  const setup=await coreMember(w,m),done=(await login(w,w.I1,setup.token)).done;
  const sid=done.newSid;
  if(path==='refresh')await w.base.authSession.update({where:{sid},data:{atExpiresAt:lapsed()}});
  const run=async()=>{
    if(path==='callback')return (await login(w,w.I2,setup.token)).done;
    if(path==='proof')return w.call(w.I2,'entry',{sid,body:{proof:done.proof}});
    if(path==='hasSession')return w.call(w.I2,'login',{sid});
    if(path==='authenticateSession')return r10Answer(w.I2.service.authenticateSession(sid,{}));
    return w.call(w.I2,'get',{sid});
  };
  return {...setup,sid,done,run};
}
for(const path of ['callback','proof','refresh','hasSession'])test(`CORE_ENTRY_MISSING_ROW U5 ${path}`,async t=>{
  const w=await world(t),m='syn-missing-'+path,f=await coreEntry(w,path,m);
  await w.base.$executeRawUnsafe('TRUNCATE "MemberRights"');
  const before=await w.base.authSession.findUnique({where:{sid:f.sid}}),tokens=kc.tokens;
  const result=await f.run();
  if(path==='callback'){
    assert.ok(result.newSid,'missing member gets waiting identity');
    const me=await w.call(w.I2,'me',{sid:result.newSid});assert.equal(me.status,403);assert.equal(me.body.code,'INSTITUTION_PENDING');
    assert.equal((await w.call(w.I2,'get',{sid:result.newSid})).status,403);
  }else if(path==='hasSession'){
    assert.ok(atProvider(result));
    assert.notEqual((await w.call(w.I2,'callback',{sid:f.sid})).location,ORIGIN+'/worklist/hpacs-lite/main.html');
  }else{
    assert.ok([401,500].includes(result.status));assert.deepEqual(await w.base.authSession.findUnique({where:{sid:f.sid}}),before);
    assert.equal(kc.tokens,tokens,'no refresh request or token storage');
  }
  await w.finish('U5 '+path);
});
for(const path of ['callback','proof','refresh','document','authenticateSession','hasSession'])test(`CORE_ENTRY_DB_DOWN U6 ${path}`,async t=>{
  const w=await world(t),m='syn-down-'+path,f=await coreEntry(w,path,m);
  const before=await w.base.authSession.findUnique({where:{sid:f.sid}}),tokens=kc.tokens;
  let reached=false;w.observe({inst:'I2',model:'memberRights',method:'findUnique',phase:'before'},()=>{reached=true;throw Error('synthetic member storage outage');});
  const result=await f.run();assert.equal(reached,true);
  if(path==='callback'){
    assert.equal(result.newSid,null);assert.equal(result.location,landing('login_failed'));
    assert.equal((await w.rows()).filter(r=>r.detail.outcome==='failure').at(-1).detail.cause,'storage_failure');
  }else assert.equal(result.status,500);
  assert.deepEqual(await w.base.authSession.findUnique({where:{sid:f.sid}}),before);
  if(path!=='callback')assert.equal(kc.tokens,tokens);
  await w.finish('U6 '+path);
});

for(const [outcome,state] of [[204,'done'],[404,'void'],[403,'void'],[503,'unknown'],['drop','unknown']])test(`CORE_ROSTER_HTTP_OUTCOMES U7 ${outcome}`,async t=>{
  const w=await world(t),m='syn-http-'+outcome,{admin}=await coreMember(w,m);
  kc.onAdmin=(name,sub)=>sub===m&&name.startsWith('PUT groups/')?outcome:undefined;
  assert.equal((await r10Patch(admin,m,coreBody('Change'))).status,200);await coreSettled(w,m);
  const record=await w.base.providerChange.findFirst({where:{sub:m,kind:'credentials'}});
  assert.equal(record.state,state);if(typeof outcome==='number'&&outcome!==204)assert.equal(record.outcome,'http_'+outcome);
  assert.equal((await coreRoster(w,m)).rosterUnconfirmed,state!=='done');
  const fresh=await coreFresh(w,m);assert.equal((await w.call(w.I2,'me',{sid:fresh.done.newSid})).body.institution,B);
  assert.equal(kc.endRequests.length,0);await w.finish('U7 '+outcome);
});

test('CORE_CREDENTIALS_COMMIT_CRASH_SECOND_API U8 intent survives crash before send; another API admits DB rights',async t=>{
  const w=await world(t),m='syn-crash-credentials',{admin}=await coreMember(w,m);
  let crashed=false;w.observe({inst:'I1',model:'$transaction',phase:'after'},e=>{
    if(e.result?.change?.kind==='credentials'&&!crashed){crashed=true;throw Error('synthetic process lost after commit');}
  });
  assert.equal((await r10Patch(admin,m,coreBody('Change'))).status,500);assert.equal(crashed,true);
  const record=await w.base.providerChange.findFirst({where:{sub:m,kind:'credentials'}});assert.equal(record.state,'unknown');assert.equal(record.outcome,null);
  assert.ok(!kc.adminCalls.some(x=>/^(PUT|POST|DELETE) /.test(x)));
  const second=w.instance('crash-restart');await second.service.onModuleInit();t.after(()=>second.service.onModuleDestroy());
  w.tick(1000);const token=await w.issue(m+'-new',{sub:m,authTime:Math.floor(Date.now()/1000)});
  const entered=(await login(w,second,token)).done;assert.ok(entered.newSid);
  assert.equal((await w.call(second,'me',{sid:entered.newSid})).body.institution,B);
  assert.equal((await coreRoster(w,m)).rosterUnconfirmed,true);await quiet(w);
  assert.equal((await w.base.providerChange.findUnique({where:{id:record.id}})).state,'unknown');
  assert.ok(!kc.adminCalls.some(x=>/^(PUT|POST|DELETE) /.test(x)));await w.finish('U8');
});

test('CORE_ROSTER_B_C_RESIDUE U9 late B and completed C leave B+C while DB C and the new session survive',async t=>{
  const w=await world(t),m='syn-residue',{admin}=await coreMember(w,m),arrived=deferred(),release=deferred();let once=true;
  t.after(()=>release.resolve());kc.beforeAdmin=(name,sub)=>{
    if(once&&sub===m&&name==='PUT groups/syn-group-'+B){once=false;arrived.resolve();return release.promise;}
  };
  assert.equal((await r10Patch(admin,m,{institution:B,roles:['radiologist']})).status,200);await within(arrived.promise,'B held after A removal');
  assert.deepEqual(kc.members[m].groups,[]);w.tick(1000);
  assert.equal((await r10Patch(r10Admin(w,w.I2),m,{institution:Z,roles:['technician']})).status,200);await coreSettled(w,m);
  assert.deepEqual(kc.members[m].groups,[Z]);const entered=await coreFresh(w,m),sid=entered.done.newSid;
  w.tick(1000);release.resolve();await w.until('both writes settled',async()=>await w.base.providerChange.count({where:{sub:m,state:'done'}})===2);
  assert.deepEqual([...kc.members[m].groups].sort(),[B,Z].sort());
  const me=await w.call(w.I2,'me',{sid});assert.equal(me.status,200);assert.equal(me.body.institution,Z);assert.deepEqual(me.body.roles,['technician']);
  assert.equal((await coreRoster(w,m)).rosterUnconfirmed,true);assert.equal(kc.endRequests.length,0);await w.finish('U9');
});

test('CORE_LEGACY_UNKNOWN_RESTART_NO_B01 U11 disable/enable unknown survive import and restart without member reconciliation',async t=>{
  const w=await world(t,{imported:false}),m=r10Member('syn-legacy-unknown');
  for(const kind of ['disable','enable'])await w.base.providerChange.create({data:{kind,sub:m,target:m,generation:1,state:'unknown',createdAt:new Date()}});
  const before=await w.base.providerChange.findMany();
  await w.I1.service.onModuleInit();t.after(()=>w.I1.service.onModuleDestroy());
  await w.until('legacy import completes',async()=>await w.base.memberRightsImport.count()===1);
  assert.equal((await w.base.memberRights.findUnique({where:{sub:m}})).suspended,true);
  await quiet(w);const calls=kc.adminCalls.length;
  await w.I2.service.onModuleInit();t.after(()=>w.I2.service.onModuleDestroy());w.tick(300000);await quiet(w);
  assert.deepEqual(await w.base.providerChange.findMany(),before);assert.equal(kc.adminCalls.length,calls);
  assert.ok(!kc.adminCalls.some(x=>/^(PUT|POST|DELETE) |sessions/.test(x)));await w.finish('U11');
});

for(const path of ['callback','proof','refresh'])test(`CORE_ENTRY_MEMBER_LOCK_TIMEOUT U13 ${path}`,async t=>{
  const w=await world(t),m='syn-lock-'+path,f=await coreEntry(w,path,m);
  const before=await w.base.authSession.findUnique({where:{sid:f.sid}});
  let reached=false,release,held;
  if(realPG()){
    release=deferred();const arrived=deferred();
    held=w.base.$transaction(async tx=>{await require('/app/dist/member-rights').lockMemberRights(tx,m);arrived.resolve();await release.promise;},{timeout:15000});
    await arrived.promise;t.after(()=>release.resolve());
  }else w.observe({inst:'I2',model:'$executeRaw',scope:'tx',phase:'before'},e=>{
    if(e.args[1]===0x4b494e4d){reached=true;throw Object.assign(Error('synthetic member lock timeout'),{code:'P2010',meta:{code:'55P03'}});}
  });
  if(path==='refresh'){const next=await w.issue(m+'-renewed',{sub:m});kc.auto=()=>reply.tokens(next);}
  const result=await f.run();release?.resolve();if(held)await held;
  if(path==='callback')assert.equal(result.newSid,null);else assert.equal(result.status,500);
  assert.deepEqual(await w.base.authSession.findUnique({where:{sid:f.sid}}),before,'proof/token unchanged on lock timeout');
  if(!realPG())assert.equal(reached,true);
  assert.equal((await w.rows()).filter(r=>r.action==='auth.entry').length,0);await w.finish('U13 '+path);
});

for(const command of CORE_COMMANDS)test(`CORE_MEMBER_LOCK_TIMEOUT O4 ${command}`,async t=>{
  const w=await world(t),m='syn-command-lock-'+command,{admin,sid}=await coreSetup(w,m,command);
  const before=await w.base.memberRights.findUnique({where:{sub:m}});let release,held,reached=false;
  if(realPG()){
    release=deferred();const arrived=deferred();held=w.base.$transaction(async tx=>{
      await require('/app/dist/member-rights').lockMemberRights(tx,m);arrived.resolve();await release.promise;
    },{timeout:15000});await arrived.promise;t.after(()=>release.resolve());
  }else w.observe({inst:'I1',model:'$executeRaw',phase:'before'},e=>{
    if(e.args[1]===0x4b494e4d){reached=true;throw Object.assign(Error('synthetic timeout'),{code:'P2010',meta:{code:'55P03'}});}
  });
  const out=await r10Patch(admin,m,coreBody(command));release?.resolve();if(held)await held;
  assert.equal(out.status,409);assert.equal(out.body.code,'MEMBER_BUSY');if(!realPG())assert.equal(reached,true);
  assert.deepEqual(await w.base.memberRights.findUnique({where:{sub:m}}),before);assert.ok(await w.base.authSession.findUnique({where:{sid}}));
  assert.equal(await w.base.providerChange.count(),0);assert.ok(!kc.adminCalls.some(x=>/^(PUT|POST|DELETE) /.test(x)));await w.finish('O4 '+command);
});

for(const blocked of ['Suspend','Cancel','missing'])test(`CORE_BLOCKED_SSO_SWITCH O2 ${blocked}`,async t=>{
  const w=await world(t),m='syn-switch-'+blocked,{token,admin}=await coreMember(w,m);
  if(blocked==='missing')await w.base.$executeRawUnsafe('TRUNCATE "MemberRights"');
  else assert.equal((await r10Patch(admin,m,coreBody(blocked))).status,200);
  const probe=await w.call(w.I1,'switch',{body:SWITCH});assert.equal(promptOf(probe),'none');
  const fresh=await answerFlow(w,w.I1,probe,token);assert.equal(promptOf(fresh),'login');assert.equal(fresh.newSid,null);
  assert.deepEqual(kc.ended,[token.idp]);
  const b=await w.issue(m+'-b',{sub:m+'-b',idp:m+'-b-sso'});
  const entered=await answerFlow(w,w.I1,fresh,b);assert.ok(entered.newSid);
  assert.equal((await w.call(w.I1,'me',{sid:entered.newSid})).body.sub,b.sub);await w.finish('O2 '+blocked);
});

for(const via of ['probe','login_required'])test(`CORE_PROBE_FRESH RV-02 ${via} rights changed has exactly one credential prompt`,async t=>{
  const w=await world(t),m='syn-fresh-'+via,{token,admin}=await coreMember(w,m);
  assert.equal((await r10Patch(admin,m,coreBody('Change'))).status,200);await quiet(w);
  const probe=await w.call(w.I1,'switch',{body:SWITCH});
  const fresh=via==='probe'?await answerFlow(w,w.I1,probe,token):await refuseFlow(w,w.I1,probe,'login_required');
  assert.equal(promptOf(fresh),'login');w.tick(1000);
  const next=await w.issue(m+'-fresh',{sub:m,idp:m+'-new-sso',authTime:Math.floor(Date.now()/1000)});
  const entered=await answerFlow(w,w.I1,fresh,next);assert.ok(entered.newSid,'first fresh authentication enters');
  assert.equal(atProvider(entered),false,'no second credential prompt');await w.finish('RV-02 '+via);
});

test('CORE_PENDING_CONTRACT RV-01 pending/invalid/missing and registration get no-rights guidance; suspended only logout',async t=>{
  const w=await world(t);
  for(const state of ['pending','invalid','missing','register','suspended']){
    const m='syn-wait-'+state,token=await w.issue(m,{sub:m,groups:[],identity:{preferred_username:m,email_verified:true}});
    if(state==='missing')await w.base.$executeRawUnsafe('TRUNCATE "MemberRights"');
    if(state==='invalid')await w.base.memberRights.update({where:{sub:m},data:{institution:A,roles:[],approved:false}});
    if(state==='suspended')await w.base.memberRights.update({where:{sub:m},data:{suspended:true}});
    const begin=await w.call(w.I1,state==='register'?'register':'login');
    const done=await answerFlow(w,w.I1,begin,token);
    if(state==='suspended'){assert.equal(done.newSid,null);continue;}
    assert.ok(done.newSid);assert.ok(done.proof);
    assert.equal((await w.call(w.I1,'entry',{sid:done.newSid,body:{proof:done.proof}})).status,200);
    const me=await w.call(w.I1,'me',{sid:done.newSid});assert.equal(me.status,403);
    assert.equal(me.body.code,state==='invalid'?'INSTITUTION_INVALID':'INSTITUTION_PENDING');assert.equal(typeof me.body.sessionId,'string');
    for(const route of ['get','authz'])assert.equal((await w.call(w.I2,route,{sid:done.newSid})).status,403);
    assert.equal((await w.call(w.I2,'logout',{sid:done.newSid})).status,204);
  }
  await w.finish('RV-01');
});

test('CORE_LOGOUT_BEARER RV-03 blocked identities may logout only after full token verification',async t=>{
  const w=await world(t),m='syn-bearer-logout',{token,admin}=await coreMember(w,m);
  for(const patch of [{suspended:true},{suspended:false,approved:false,institution:null,roles:[]}]){
    await w.base.memberRights.update({where:{sub:m},data:patch});
    assert.equal((await w.call(w.I1,'logout',{bearer:token.access,csrf:false})).status,204);
  }
  const claims=jose.decodeJwt(token.access);
  for(const variant of ['signature','issuer','audience','expiry']){
    const value={...claims,...({issuer:{iss:'https://wrong.test'},audience:{aud:'wrong'},expiry:{exp:Math.floor(Date.now()/1000)-1}}[variant]??{})};
    const bad=await new jose.SignJWT(value).setProtectedHeader({alg:'RS256',kid:KEYS.main.kid}).sign(KEYS[variant==='signature'?'other':'main'].privateKey);
    assert.equal((await w.call(w.I1,'logout',{bearer:bad,csrf:false})).status,401,variant);
  }
  await w.finish('RV-03');
});

test('CORE_ROSTER_STATUS RV-04 Suspend and settled Activate do not invent roster drift; Cancel is still unconfirmed',async t=>{
  const w=await world(t),m='syn-roster-note',{admin}=await coreMember(w,m);
  assert.equal((await r10Patch(admin,m,coreBody('Change'))).status,200);await coreSettled(w,m);
  assert.equal((await coreRoster(w,m)).rosterUnconfirmed,false);w.tick(1000);
  const suspend=await r10Patch(admin,m,coreBody('Suspend'));assert.equal(suspend.status,200);assert.equal(suspend.user.rosterUnconfirmed,false);
  assert.equal((await coreRoster(w,m)).rosterUnconfirmed,false);w.tick(1000);
  assert.equal((await r10Patch(admin,m,coreBody('Activate'))).status,200);await coreSettled(w,m);
  assert.equal((await coreRoster(w,m)).rosterUnconfirmed,false);w.tick(1000);
  assert.equal((await r10Patch(admin,m,coreBody('Cancel'))).status,200);assert.equal((await coreRoster(w,m)).rosterUnconfirmed,true);
  await w.finish('RV-04');
});

test('CORE_HASSESSION RV-05 refused or stale-version cookie starts login; unrelated callback never answers work',async t=>{
  const w=await world(t),m='syn-hassession',{sid}=await coreMember(w,m);
  for(const patch of [{suspended:true},{suspended:false,version:2}]){
    await w.base.memberRights.update({where:{sub:m},data:patch});
    assert.equal(atProvider(await w.call(w.I1,'login',{sid})),true,'refused cookie must start a flow');
    const stray=await w.call(w.I1,'callback',{sid,query:{code:'unowned',state:'unowned'}});
    assert.equal(atProvider(stray),true,'unowned state cannot answer work');assert.equal(stray.newSid,null);
  }
  await w.finish('RV-05');
});

for(const command of CORE_COMMANDS)for(const ending of ['logout','idle','sweep'])for(const order of ['end-first','command-first'])
test(`CORE_COMMAND_END_RACE O3 ${command}/${ending}/${order}`,async t=>{
  const w=await world(t),m='syn-end-'+command+'-'+ending+'-'+order,{admin,sid}=await coreMember(w,m);
  if(ending!=='logout')await w.base.authSession.update({where:{sid},data:{lastSeenAt:past(IDLE+1)}});
  let finishedSweep=false;
  w.observe({inst:'I2',model:'$transaction',phase:'after'},()=>{finishedSweep=true;});
  const end=async()=>{
    if(ending==='sweep'){
      await w.I2.service.onModuleInit();t.after(()=>w.I2.service.onModuleDestroy());w.tick(HOUR);
      await w.until('sweep completed',async()=>finishedSweep||!await w.base.authSession.findUnique({where:{sid}}));
      await quiet(w);return;
    }
    return w.call(w.I2,ending==='idle'?'get':'logout',{sid});
  };
  if(order==='end-first'){
    // In PG the command has read its list while the other connection deletes and commits.
    // The stand-in serializes whole transactions: hold before TX there, then run the same order.
    const hold=realPG()?w.pause({inst:'I1',scope:'tx',model:'authSession',method:'findMany',phase:'after'})
      :w.pause({inst:'I1',model:'$transaction',phase:'before'});
    const run=r10Patch(admin,m,coreBody(command));await hold.arrived();await end();
    assert.equal(await w.base.authSession.count({where:{sid}}),0);hold.release();assert.equal((await run).status,200);
  }else{
    const hold=ending==='sweep'?w.pause({inst:'I2',scope:'root',model:'authSession',method:'findMany',phase:'after'})
      :w.pause({inst:'I2',scope:'root',model:'authSession',method:'findUnique',phase:'after'});
    const run=end();await hold.arrived();assert.equal((await r10Patch(admin,m,coreBody(command))).status,200);hold.release();await run;
  }
  await quiet(w);
  const ended=(await w.rows()).filter(r=>r.target===m&&['auth.logout','auth.session.expired'].includes(r.action));
  assert.equal(ended.length,1,'exactly the actual delete writes one end audit');
  assert.equal(ended[0].detail.cause,order==='command-first'?'isolation':ending==='logout'?'logout':ending==='idle'?'idle':'sweep');
  assert.equal(await w.base.authSession.count({where:{sid}}),0);await w.finish('O3 '+command+'/'+ending+'/'+order);
});

for(const source of ['consultation','colleagues'])test(`CORE_ROSTER_SOURCE_SPLIT U12 ${source}`,async t=>{
  const w=await world(t),caller={kind:'member',institution:A,sub:'syn-sender',actor:'sender@synthetic.test',roles:['radiologist']};
  const provider={id:'syn-roster-only',username:'roster',email:'roster@synthetic.test',enabled:true,serviceAccountClientId:null,groups:[A],roles:['radiologist']};
  await coreMember(w,provider.id);await w.base.memberRights.update({where:{sub:provider.id},data:{suspended:true,institution:B}});
  await coreMember(w,'syn-db-only');
  const kcStub={assignmentReaders:async()=>[provider],usersInGroupWithRole:async()=>[{id:provider.email,name:'Roster'}]};
  if(source==='consultation'){
    const {ConsultationService}=require('/app/dist/consultation.service');
    const out=await new ConsultationService(w.I1.prisma,kcStub,null).candidates(caller);
    assert.deepEqual(out.readers.map(x=>x.sub),[provider.id],'picker follows provider, including its stale member');
  }else{
    const {PacsService}=require('/app/dist/pacs.service');
    const out=await new PacsService(w.I1.prisma,null,kcStub,null,null).colleagues(caller);
    assert.deepEqual(out.map(x=>x.id),[provider.email]);
  }
  await w.finish('U12 '+source);
});

test('CORE_IMPORT_OLD_A_CALLBACK_BEARER O1 existing-session and Bearer-only old A authentications never acquire imported B rights',async t=>{
  const w=await world(t,{imported:false}),users=[],tokens=[];
  for(const suffix of ['cookie','bearer-only']){
    const sub='syn-import-old-'+suffix,token=await w.issue(sub,{sub,authTime:Math.floor(Date.now()/1000)});
    tokens.push(token);if(suffix==='cookie')await w.session(token);
    users.push({id:sub,username:sub,email:sub+'@synthetic.test',emailVerified:true,enabled:true,groups:[B],roles:['radiologist'],firstName:'SYN',lastName:'Import'});
  }
  await w.base.$executeRawUnsafe('TRUNCATE "MemberRights"');
  await require('/app/dist/member-rights-import').importMemberRights(w.I1.prisma,{listUsers:async()=>({total:users.length,users})});
  for(const token of tokens){
    assert.equal((await w.call(w.I1,'get',{bearer:token.access})).status,401);
    const old=(await login(w,w.I2,token)).done;
    assert.equal(old.newSid,null);assert.equal(promptOf(old),'login','old authentication must become a fresh flow');
    assert.equal(await w.base.authSession.count({where:{sub:token.sub,rightsVersion:1}}),0);
  }
  await w.finish('O1');
});

test('CORE_FRESH_FLOW_TIME fresh recovery cannot reuse authentication older than its own flow even after the rights boundary',async t=>{
  const w=await world(t),m='syn-fresh-time',{admin}=await coreMember(w,m);
  assert.equal((await r10Patch(admin,m,coreBody('Change'))).status,200);await quiet(w);
  w.tick(1000);const old=await w.issue(m+'-old',{sub:m,authTime:Math.floor(Date.now()/1000)});w.tick(4000);
  const probe=await w.call(w.I1,'switch',{body:SWITCH}),fresh=await refuseFlow(w,w.I1,probe,'login_required');
  assert.equal(promptOf(fresh),'login');assert.equal((await answerFlow(w,w.I1,fresh,old)).newSid,null);
  const probe2=await w.call(w.I1,'switch',{body:SWITCH}),fresh2=await refuseFlow(w,w.I1,probe2,'login_required');
  const now=await w.issue(m+'-now',{sub:m,authTime:Math.floor(Date.now()/1000)});
  assert.ok((await answerFlow(w,w.I1,fresh2,now)).newSid);await w.finish('CORE_FRESH_FLOW_TIME');
});

test('CORE_REALM_404 a realm read 404 is a failed import, never a ready empty realm',async t=>{
  const w=await world(t,{imported:false});kc.realmReadStatus=404;
  await assert.rejects(require('/app/dist/member-rights-import').importMemberRights(w.I1.prisma,new KeycloakService()),e=>e.getStatus?.()===503);
  assert.equal(await w.base.memberRightsImport.count(),0);assert.equal((await w.call(w.I1,'health')).body.memberRights,'pending');
  kc.beforeAdmin=name=>name==='GET read'?404:undefined;
  assert.equal(await new KeycloakService().getUser('syn-absent'),null,'single-user lookup retains its absence contract');
  await w.finish('CORE_REALM_404');
});

for(const stage of ['GET groups','GET role-mappings/realm','POST role-mappings/realm'])
test(`CORE_ROSTER_HTTP_STAGE ${stage} 404 records void with its HTTP outcome`,async t=>{
  const w=await world(t),m='syn-stage-'+stage.replace(/\W/g,'-'),{admin}=await coreMember(w,m);let armed=false;
  w.observe({inst:'I1',scope:'tx',model:'providerChange',method:'create',phase:'after'},()=>{armed=true;});
  kc.beforeAdmin=(name,sub)=>armed&&sub===m&&name===stage?404:undefined;
  assert.equal((await r10Patch(admin,m,coreBody('Change'))).status,200);await coreSettled(w,m);
  const record=await w.base.providerChange.findFirst({where:{sub:m,kind:'credentials'}});
  assert.deepEqual([record.state,record.outcome],['void','http_404']);
  kc.beforeAdmin=null;assert.equal((await coreRoster(w,m)).rosterUnconfirmed,true);
  assert.equal((await w.base.memberRights.findUnique({where:{sub:m}})).institution,B);await w.finish('CORE_ROSTER_HTTP_STAGE '+stage);
});

// D632 / REQ-S7-U5-DB-RIGHTS -> RISK-LEGACY-LOCKOUT / IDENTITY-REBIND / LOST-CAS / FALSE-PENDING -> CORE_* below.
test('CORE_PENDING_COUNT_UNREGISTERED_PAGED_DELETED counts the merged realm, without rights writes on any page',async t=>{
  const w=await world(t),ids=['syn-count-new','syn-count-cancel','syn-count-approved','syn-count-pending','syn-count-deleted'];
  for(const sub of ids.slice(1))await coreMember(w,sub);
  for(const sub of [ids[1],ids[3],ids[4]])await w.base.memberRights.update({where:{sub},data:{approved:false,institution:null,roles:[],suspended:sub===ids[1]}});
  // Two new users and one deleted row cannot accidentally cancel each other's count error.
  const users=[...ids.slice(0,4),'syn-count-new-second'].map(id=>({id,username:id,email:id+'@synthetic.test',emailVerified:true,groups:[],roles:[],enabled:true}));
  const provider={listUsers:async page=>({page,pageSize:2,total:users.length,users:users.slice((page-1)*2,page*2)})};
  const {AdminService}=require('/app/dist/admin.service'),admin=new AdminService(w.I1.prisma,provider,null,w.I1.service);
  const before=await w.base.memberRights.findMany({orderBy:{sub:'asc'}}),listed=[];
  for(const page of [1,2,3]){
    const out=await admin.listUsers(page,R10_CALLER);assert.equal(out.pendingCount,4);assert.equal(out.total,5);listed.push(...out.users);
  }
  assert.equal(listed.filter(u=>u.approvalState==='PENDING').length,4);
  assert.equal(listed.find(u=>u.id===ids[0]).version,null);assert.ok(!listed.some(u=>u.id===ids[4]));
  assert.deepEqual(await w.base.memberRights.findMany({orderBy:{sub:'asc'}}),before);
  assert.equal(await w.base.providerChange.count(),0);await w.finish('CORE_PENDING_COUNT');
});

test('CORE_REGISTER_APPROVE_CAS two APIs observe a missing row; loser is 409, with one rights audit and one publication',async t=>{
  const w=await world(t),m=r10Member('syn-register-race');kc.members[m].emailVerified=true;
  const a=w.pause({inst:'I1',scope:'root',model:'memberRights',method:'findUnique',phase:'after'});
  const b=w.pause({inst:'I2',scope:'root',model:'memberRights',method:'findUnique',phase:'after'});
  const body={approvalState:'APPROVED',institution:A,roles:['radiologist'],enabled:true,version:null};
  const first=r10Patch(r10Admin(w),m,body),second=r10Patch(r10Admin(w,w.I2),m,body);
  await Promise.all([a.arrived(),b.arrived()]);assert.equal(await w.base.memberRights.count({where:{sub:m}}),0);
  a.release();b.release();const results=await Promise.all([first,second]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  assert.equal(results.find(r=>r.status===409).body.code,'MEMBER_VERSION_CONFLICT');
  await coreSettled(w,m);
  assert.equal(await w.base.memberRights.count({where:{sub:m}}),1);
  assert.equal(await w.base.auditLog.count({where:{target:m,action:'admin.user.approve'}}),1);
  assert.equal(await w.base.providerChange.count({where:{sub:m,kind:'credentials'}}),1,'loser records/sends no publication');
  assert.ok(!kc.adminCalls.some(x=>/enable|disable|sessions|logout/.test(x)));
  await w.finish('CORE_REGISTER_APPROVE_CAS');
});

test('CORE_IMPORT_TWO_INSTANCES_FIRST_BOOT overlapping first imports commit one marker, boundary and legacy intent',async t=>{
  const w=await world(t,{imported:false}),m='syn-two-imports',arrived=deferred(),release=deferred();t.after(()=>release.resolve());
  let readers=0,sends=0,commits=0;
  const user={id:m,username:m,email:m+'@synthetic.test',emailVerified:true,enabled:false,groups:[A],roles:['radiologist']};
  const provider={listUsers:async()=>{if(++readers===2)arrived.resolve();await release.promise;return {total:1,users:[user]};},
    setEnabled:async(sub,enabled)=>{sends++;assert.equal(sub,m);assert.equal(enabled,true);assert.equal(await w.base.memberRightsImport.count(),1);}};
  for(const inst of ['I1','I2'])w.observe({inst,scope:'tx',model:'memberRightsImport',method:'create',phase:'after'},()=>{commits++;});
  const {importMemberRights}=require('/app/dist/member-rights-import');
  const first=importMemberRights(w.I1.prisma,provider),second=importMemberRights(w.I2.prisma,provider);
  await within(arrived.promise,'both APIs read the missing marker');release.resolve();await Promise.all([first,second]);
  await coreSettled(w,m);const marker=await w.base.memberRightsImport.findUnique({where:{id:'realm-v1'}});
  assert.equal(commits,1);assert.equal(sends,1);assert.equal(await w.base.memberRightsImport.count(),1);
  assert.equal(await w.base.providerChange.count({where:{sub:m,kind:'credentials'}}),1);
  const row=await w.base.memberRights.findUnique({where:{sub:m}});assert.equal(row.suspended,true);assert.equal(row.newAuthAfter.getTime(),marker.completedAt.getTime());
  await importMemberRights(w.I1.prisma,provider);assert.equal(readers,2);assert.equal(sends,1);await w.finish('CORE_IMPORT_TWO_INSTANCES');
});

for(const cut of ['503','crash','404','held'])test(`CORE_LEGACY_DISABLED_RECOVERY_503_CRASH_LATE_DISABLE ${cut}`,async t=>{
  const w=await world(t,{imported:false}),m=r10Member('syn-legacy-'+cut);kc.members[m].enabled=false;kc.members[m].emailVerified=true;
  const {importMemberRights,retryMemberRoster}=require('/app/dist/member-rights-import'),provider=new KeycloakService();
  const held=deferred(),arrived=deferred();t.after(()=>held.resolve());let crashed=false;
  if(cut==='crash')w.observe({inst:'I1',model:'$transaction',phase:'after'},()=>{if(!crashed){crashed=true;throw Error('synthetic process lost after import commit');}});
  kc.beforeAdmin=async(name,sub)=>{if(name!=='PUT enable'||sub!==m)return;
    assert.equal(await w.base.memberRightsImport.count(),1);assert.equal((await w.base.memberRights.findUnique({where:{sub:m}})).suspended,true);
    if(cut==='held'){arrived.resolve();await held.promise;}else if(cut==='503')return 503;else if(cut==='404')return 404;
  };
  if(cut==='crash')await assert.rejects(importMemberRights(w.I1.prisma,provider),/synthetic process/);
  else await importMemberRights(w.I1.prisma,provider);
  assert.equal(await w.base.providerChange.count({where:{sub:m,kind:'credentials'}}),1,'commit durably records the sole legacy intent before any answer');
  if(cut==='held'){await within(arrived.promise,'legacy enable pending');assert.equal((await coreRoster(w,m)).rosterUnconfirmed,true);held.resolve();}
  if(cut!=='crash')await coreSettled(w,m);
  const records=await w.base.providerChange.findMany({where:{sub:m,kind:'credentials'}});assert.equal(records.length,1);
  assert.equal(records[0].state,cut==='404'?'void':cut==='held'?'done':'unknown');
  assert.equal((await coreRoster(w,m)).rosterUnconfirmed,cut!=='held');
  assert.equal((await w.base.memberRights.findUnique({where:{sub:m}})).suspended,true);
  const sent=kc.adminCalls.filter(c=>c==='PUT enable').length;
  await w.I2.service.onModuleInit();await quiet(w);w.I2.service.onModuleDestroy();
  assert.equal(kc.adminCalls.filter(c=>c==='PUT enable').length,sent,'restart never retries the transition in background');
  kc.beforeAdmin=null;const rights=await w.base.memberRights.findUnique({where:{sub:m}});
  const result=await retryMemberRoster(w.I2.prisma,provider);assert.equal(result.unconfirmed,0);assert.equal(result.attempted,cut==='held'?0:1);
  assert.equal((await retryMemberRoster(w.I2.prisma,provider)).attempted,0,'operator retry is idempotent');
  assert.equal(await w.base.providerChange.count({where:{sub:m,kind:'credentials'}}),1,'retry retains the one intent');
  assert.deepEqual(await w.base.memberRights.findUnique({where:{sub:m}}),rights,'publication cannot change rights');
  assert.equal(kc.members[m].enabled,true);
  // A late legacy disable (from a pre-transition caller) cannot grant or remove DB rights.
  kc.members[m].enabled=false;w.tick(1000);const old=await w.issue(m+'-late',{sub:m,authTime:Math.floor(Date.now()/1000)});
  assert.equal((await w.call(w.I2,'me',{bearer:old.access})).status,401);assert.equal((await login(w,w.I2,old)).done.newSid,null);
  assert.equal((await r10Patch(r10Admin(w),m,{enabled:true})).status,200);await quiet(w);
  const enabledCalls=kc.adminCalls.filter(c=>c==='PUT enable').length;
  assert.equal(enabledCalls,cut==='held'?1:cut==='crash'?1:2,'Activate adds no provider command');
  assert.equal(kc.members[m].enabled,false,'late disable is not repaired by a normal command');
  assert.equal((await w.call(w.I2,'me',{bearer:old.access})).status,401,'neither the late effect nor Activate reopens an older authentication');
  await w.finish('CORE_LEGACY_DISABLED '+cut);
});

test('CORE_RETRY_ROSTER replays unknown and void ordinary groups/roles intents without enable or DB rights changes',async t=>{
  const w=await world(t),m='syn-roster-retry',{admin}=await coreMember(w,m),{retryMemberRoster}=require('/app/dist/member-rights-import');
  let armed=false;w.observe({inst:'I1',scope:'tx',model:'providerChange',method:'create',phase:'after'},()=>{armed=true;});
  kc.beforeAdmin=name=>armed&&name==='GET groups'?503:undefined;
  assert.equal((await r10Patch(admin,m,{institution:B,roles:['clinician']})).status,200);await coreSettled(w,m);
  const before=await w.base.memberRights.findUnique({where:{sub:m}});kc.beforeAdmin=null;
  assert.deepEqual(await retryMemberRoster(w.I2.prisma,new KeycloakService()),{attempted:1,unconfirmed:0});
  assert.deepEqual(kc.members[m].groups,[B]);assert.deepEqual(kc.members[m].roles,['clinician']);
  assert.deepEqual(await w.base.memberRights.findUnique({where:{sub:m}}),before);
  assert.ok(!kc.adminCalls.some(x=>/enable|disable|sessions|logout/.test(x)));await w.finish('CORE_RETRY_ROSTER');
});

for(const command of CORE_COMMANDS)test(`CORE_COMMAND_NO_PROVIDER_ENABLE ${command}`,async t=>{
  const w=await world(t),m='syn-no-enable-'+command,{admin}=await coreSetup(w,m,command);
  assert.equal((await r10Patch(admin,m,coreBody(command))).status,200);await quiet(w);
  assert.ok(!kc.adminCalls.some(x=>/enable|disable|sessions|logout/.test(x)));assert.equal(kc.endRequests.length,0);
  assert.equal(await w.base.providerChange.count({where:{sub:m,kind:'credentials'}}),['Approve','Change'].includes(command)?1:0);
  await w.finish('CORE_COMMAND_NO_PROVIDER_ENABLE '+command);
});

test('CORE_REVIEWER_IDENTITY_LATE_CALLBACK_AND_BEARER delayed old identity never rewrites DB identity; Bearer uses current token identity',async t=>{
  const w=await world(t),m='syn-late-identity',{token}=await coreMember(w,m),before=await w.base.memberRights.findUnique({where:{sub:m}});
  const begin=await w.call(w.I1,'login'),hold=w.gate('I1','tx.open'),old=answerFlow(w,w.I1,begin,token);await hold.arrived();
  const changed=await w.issue(m+'-new',{sub:m,email:'new-reviewer@synthetic.test',identity:{preferred_username:'new-reviewer'}});
  const fresh=await login(w,w.I2,changed);assert.ok(fresh.done.newSid);
  const afterFresh=await w.base.memberRights.findUnique({where:{sub:m}});
  hold.release();assert.ok((await old).newSid);
  assert.deepEqual(afterFresh,before,'the newer callback is not an identity writer either');
  assert.deepEqual(await w.base.memberRights.findUnique({where:{sub:m}}),before,'callbacks are not identity-roster writers');
  const me=await w.call(w.I2,'me',{bearer:changed.access});assert.equal(me.status,200);assert.equal((await guardView(w,changed.access)).actor,'new-reviewer@synthetic.test');
  assert.deepEqual(await w.base.memberRights.findUnique({where:{sub:m}}),before);await w.finish('CORE_REVIEWER_IDENTITY');
});

for(const state of ['missing','pending','invalid'])test(`CORE_GUIDANCE_HASSESSION ${state} returns work without a new IdP flow but work stays forbidden`,async t=>{
  const w=await world(t),m='syn-guidance-'+state,token=await w.issue(m,{sub:m}),sid=await w.session(token);
  if(state==='missing'){await w.base.$executeRawUnsafe('TRUNCATE "MemberRights"');await w.base.authSession.update({where:{sid},data:{rightsVersion:0}});}
  // Even a retained, inconsistent pending row carrying stale scope cannot become work authority.
  else await w.base.memberRights.update({where:{sub:m},data:{approved:false,institution:state==='invalid'?A:null,roles:state==='invalid'?['radiologist']:[]}});
  const before=await w.base.authSession.count(),out=await w.call(w.I1,'login',{sid});
  assert.equal(atProvider(out),false);assert.equal(out.location,landing('session_active'));
  assert.equal((await w.call(w.I1,'callback',{sid,query:{code:'unowned',state:'unowned'}})).location,ORIGIN+'/worklist/hpacs-lite/main.html');
  assert.equal(await w.base.authSession.count(),before);assert.equal((await w.call(w.I2,'get',{sid})).status,403);
  assert.equal(kc.tokens,0);await w.finish('CORE_GUIDANCE_HASSESSION '+state);
});

test('CORE_LOGIN_RIGHTS_PENDING import absence is 401 AUTH_RIGHTS_PENDING and a distinct audit failure cause',async t=>{
  const w=await world(t,{imported:false}),token=await w.issue('syn-rights-pending',{sub:'syn-rights-pending'}),sid=await w.session(token);
  const out=await w.call(w.I1,'get',{sid});assert.equal(out.status,401);assert.equal(out.body.code,'AUTH_RIGHTS_PENDING');
  assert.equal((await login(w,w.I2,token)).done.newSid,null);
  const failed=(await w.rows()).filter(row=>row.action==='auth.login'&&row.detail.outcome==='failure');
  assert.equal(failed.length,1);assert.equal(failed[0].detail.cause,'rights_pending');await w.finish('CORE_LOGIN_RIGHTS_PENDING');
});

for(const stage of ['groups','role-mappings/realm'])test(`CORE_ROSTER_DISAPPEARS ${stage} returns absent, while other HTTP failures stay 503`,async t=>{
  const w=await world(t),m=r10Member('syn-gone'),provider=new KeycloakService();
  kc.beforeAdmin=name=>name==='GET '+stage?404:undefined;
  let member;await assert.doesNotReject(async()=>{member=await provider.getUser(m);},'a deleted user is an absence, not a provider outage');
  assert.equal(member,null);
  kc.beforeAdmin=name=>name==='GET '+stage?503:undefined;
  await assert.rejects(provider.getUser(m),e=>e.getStatus?.()===503);await w.finish('CORE_ROSTER_DISAPPEARS '+stage);
});

test('CORE_COMMAND_DB_CLOCK rights boundary uses transaction DB time despite application clock skew',async t=>{
  const w=await world(t),m='syn-db-clock',{admin}=await coreMember(w,m);w.realDatabaseClock=true;let dbTime;
  w.observe({inst:'I1',model:'$transaction',phase:'started'},async e=>{dbTime=(await e.client.$queryRaw`SELECT now() AS boundary`)[0].boundary;});
  if(realPG())w.tick(7*24*HOUR);
  assert.equal((await r10Patch(admin,m,{enabled:false})).status,200);
  const row=await w.base.memberRights.findUnique({where:{sub:m}});assert.equal(row.newAuthAfter.getTime(),dbTime.getTime());
  if(realPG())assert.ok(Math.abs(row.newAuthAfter.getTime()-Date.now())>HOUR,'database and application clocks were independently exercised');
  await w.finish('CORE_COMMAND_DB_CLOCK');
});
