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
const AUTH_ACTIONS = ['auth.login', 'auth.logout', 'auth.session.expired'];
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
  members: {}, userLogouts: [], adminDown: false, institutionsDown: false, institutionReads: 0, adminFail: {}, adminCalls: [], onAdmin: null, beforeAdmin: null,
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
      // Fail the institution list independently: member identity and memberships still answer normally.
      if (path === '/admin/realms/kin/groups') {
        kc.institutionReads++;
        return kc.institutionsDown ? send(503, { error: 'unavailable' })
          : send(200, [A, B, Z].map(name => ({ id: 'syn-group-' + name, name })));
      }
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
            return done(200, { id, username: account.username, email: account.email, enabled: account.enabled,
              firstName: account.firstName ?? '', lastName: account.lastName ?? '', emailVerified: account.emailVerified ?? true });
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
test('U5S-ENTRY-01 callback delivers a session to the approved member final document', async t => {
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
    assert.ok(done.newSid, label);
    assert.equal(target.hash, '', 'callback redirects directly');
    const entry = await w.call(w.I1, 'me', { sid: done.newSid });
    assert.equal(entry.status, status, label);
    const me = await w.call(w.I1, 'me', { sid: done.newSid, binding: entry.body.sessionId });
    assert.equal(me.status, status, label);
    if (status === 200) assert.deepEqual(me.body.roles, roles.filter(r => ['admin','radiologist','technician','clinician'].includes(r)), label);
    assert.equal(rowsOf(await w.rows(), sub).filter(row => row.action === 'auth.login').length, 1, label);
  }
  await w.finish('U5S-ENTRY-01');
});

test('U5S-ENTRY-02 bootstrap me uses DB rights when refreshed JWT claims change', async t => {
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
    const entry = await w.call(w.I1, 'me', { sid: done.newSid });
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
const { AccessLedgerStore } = require('/app/dist/emr-runtime/store');
const { FailureJournal, FailureSpool } = require('/app/dist/emr-runtime/failure-journal');
const { createRecordPort } = require('/app/dist/emr-runtime/record-port');
const { createBackgroundWorkRegistry } = require('/app/dist/emr-runtime/background-work');
const { KeycloakService } = require('/app/dist/keycloak.service');
const { AuthGuard } = require('/app/dist/auth.guard');
const { createRequestContext } = require('/app/dist/emr-runtime/request-context');
const { createRequestIngress } = require('/app/dist/emr-runtime/request-ingress');
const { EventEmitter } = require('node:events');
const { Socket } = require('node:net');
const { AuthController } = require('/app/dist/auth.controller');
const { PacsController } = require('/app/dist/pacs.controller');


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
  await base.$executeRawUnsafe('TRUNCATE "MemberIsolation"');
  await base.$executeRawUnsafe('TRUNCATE "MemberRights"');
  await base.$executeRawUnsafe('TRUNCATE "MemberRightsImport"');
  await base.$executeRawUnsafe('TRUNCATE "ProviderChange" RESTART IDENTITY');
  await base.$transaction([base.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    base.$executeRawUnsafe(`TRUNCATE emr_access.audit_projection, emr_access.access_target,
      emr_access.access_entry, emr_access.entry_receipt, emr_access.attempt_outcome,
      emr_access.attempt, emr_access.operation, emr_access.failure_entry, emr_access.disposal_fact,
      "AuditLog" RESTART IDENTITY`)]);
  const [{ left }] = await base.$queryRawUnsafe(`SELECT (SELECT count(*) FROM "AuditLog") + (SELECT count(*) FROM "AuthSession") + (SELECT count(*) FROM "MemberIsolation") + (SELECT count(*) FROM "ProviderChange") AS left`);
  assert.equal(Number(left), 0, 'every world starts with no session, no end mark, no isolation fact, no provider change record and no audit row');
  Object.assign(kc, { held: [], waiters: [], auto: null, logoutMode: 'ok', onLogout: null, logouts: 0, tokens: 0, codes: [],
    certs: 'ok', certRequests: 0, abandoned: 0, ended: [], alive: null, serviceTokens: 0, serviceMode: 'ok', endRequests: [],
    members: {}, userLogouts: [], adminDown: false, institutionsDown: false, institutionReads: 0, adminFail: {}, adminCalls: [], onAdmin: null, beforeAdmin: null,
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
    if (scope === 'tx') return method === 'deleteMany' ? 'tx.delete' : method === 'create' ? 'tx.create' : 'tx.' + method;
    if (method === 'findUnique') return 'read';
    if (method === 'findMany') return args?.select?.sid ? 'admissions' : 'sweepRead';
    if (method === 'updateMany') return Object.keys(args?.data ?? {}).join() === 'lastSeenAt' ? 'touch' : 'store';
    return method;
  };
  const delegate = (inst, client, model, scope, enter = async () => {}) => new Proxy({}, { get(_target, method) {
    const real = client[model][method];
    if (typeof real !== 'function') return real;
    return async args => {
      await enter();
      if (['authSession', 'auditLog'].includes(model)) await hit(inst, pointOf(scope, model, method, args));
      await observe({ inst, scope, model, method, args, phase: 'before' });
      const result = await real.call(client[model], args);
      await observe({ inst, scope, model, method, args, result, phase: 'after' });
      return result;
    };
  } });
  const recorder = inst => new Proxy({}, { get(_target, key) {
    if (key === '$transaction') return async (fn, options) => {
      let opened = false;
      const result = await base.$transaction(async tx => {
        // Session-race gates observe the business transaction. The ledger's
        // separate identity lookup has no business delegate/execute call.
        const enter = async () => {
          if (opened) return;
          opened = true;
          await hit(inst, 'tx.open');
          await observe({ inst, model: '$transaction', phase: 'before' });
          w.calls.push(inst + ':tx:start');
          await observe({ inst, model: '$transaction', phase: 'started', client: tx });
        };
        const view = new Proxy({}, { get(_t, k) {
          if (['authSession', 'auditLog', 'memberIsolation', 'memberRights', 'memberRightsImport', 'providerChange'].includes(k)) return delegate(inst, tx, k, 'tx', enter);
          const value = tx[k];
          // The scenarios advance a virtual provider/application clock. Project DB timestamps onto that timeline;
          // CORE_COMMAND_DB_CLOCK opts out and proves the boundary against the actual PG transaction clock.
          if (k === '$queryRaw') return async (...args) => {
            const result = await value.apply(tx,args);
            if (w.realDatabaseClock) return result;
            return result.map(row => Object.fromEntries(Object.entries(row).map(([key,v]) => [key,v instanceof Date ? new Date() : v])));
          };
          if (k === '$executeRaw') return async (...args) => {
            await enter();
            await observe({ inst, scope:'tx', model:'$executeRaw', method:'execute', args, phase:'before' });
            const result = await value.apply(tx,args);
            await observe({ inst, scope:'tx', model:'$executeRaw', method:'execute', args, result, phase:'after' });
            return result;
          };
          return typeof value === 'function' ? value.bind(tx) : value;
        } });
        const out = await fn(view);
        if (opened) w.calls.push(inst + ':tx:end');
        return out;
      }, options);
      if (opened) await observe({ inst, model: '$transaction', phase: 'after', result });
      return result;
    };
    if (['authSession', 'auditLog', 'memberIsolation', 'memberRights', 'memberRightsImport', 'providerChange'].includes(key)) return delegate(inst, base, key, 'root');
    const value = base[key];
    return typeof value === 'function' ? value.bind(base) : value;
  } });
  const make = name => {
    // The product's own Keycloak admin client, over the fake's address: each instance its own (its own service token).
    // `prisma` is the instance's recording view, for the other product services a case builds over the same instance.
    const prisma = recorder(name);
    // Exercise the real ledger on this world's recording client: transaction
    // observations and SQL failures still reach the actual business boundary.
    const spool = fs.mkdtempSync(require('node:path').join(os.tmpdir(), 'kin-auth-ledger-'));
    const journal = new FailureJournal(prisma, new FailureSpool(spool));
    const { port: ledger, control } = createRecordPort(new AccessLedgerStore(prisma, journal));
    const background = createBackgroundWorkRegistry();
    const service = new AuthService(prisma, new KeycloakService(), ledger, background.work);
    t.after(async () => {
      await service.onModuleDestroy(); background.quiesce(); await background.drained(); control.close(); await control.drained(); await journal.close();
      fs.rmSync(spool, { recursive: true });
    });
    return { name, service, prisma, ledger, background, guard: new AuthGuard(new Reflector(), service,
      createRequestContext(createRequestIngress({ proxyPeers: [] }), ledger).capture), controller: new AuthController(service), handled: 0 };
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
      get: ['GET', '/api/studies', PacsController, PacsController.prototype.studies],
      health: ['GET', '/api/health', PacsController, PacsController.prototype.health],
      me: ['GET', '/api/me', PacsController, PacsController.prototype.me],
      authz: ['GET', '/api/authz/dicom', PacsController, PacsController.prototype.authzDicom],
      logout: ['POST', '/api/auth/logout', AuthController, AuthController.prototype.logout],
      login: ['GET', '/api/auth/login', AuthController, AuthController.prototype.login],
      register: ['GET', '/api/auth/register', AuthController, AuthController.prototype.register],
      switch: ['POST', '/api/auth/login', AuthController, AuthController.prototype.startLogin],
      signup: ['POST', '/api/auth/register', AuthController, AuthController.prototype.startRegister],
      callback: ['GET', '/api/auth/callback', AuthController, AuthController.prototype.callback],
    };
    const [method, path, cls, handler] = routes[kind];
    const cookies = [sid ? 'kin_sid=' + encodeURIComponent(sid) : null, cookie ?? null].filter(Boolean).join('; ');
    const unbound = ['me', 'login', 'register', 'callback'].includes(kind);
    const bound = binding === undefined ? (sid && !unbound ? inst.service.sessionRef(sid) : null) : binding;
    const req = Object.assign(new http.IncomingMessage(new Socket()), { method, originalUrl: path, url: path, route: { path }, query, body, headers: {
      ...(cookies ? { cookie: cookies } : {}), ...(ip === null ? {} : { 'x-real-ip': ip }),
      ...(method === 'POST' && csrf ? { 'x-kin-csrf': '1' } : {}), ...(bound ? { 'x-kin-session': bound } : {}),
      ...(bearer ? { authorization: 'Bearer ' + bearer } : {}), ...headers } });
    const res = Object.assign(new EventEmitter(), { req, setCookies: [], sentHeaders: {}, headersSent: false, statusCode: null, body: undefined, location: null, sent: false,
      append(name, value) { if (name === 'Set-Cookie') this.setCookies.push(value); },
      setHeader(name, value) { this.sentHeaders[String(name).toLowerCase()] = value; },
      redirect(status, url) { this.statusCode = status; this.location = url; this.sent = true; this.emit('finish'); },
      status(code) { this.statusCode = code; return this; },
      send(body) { this.body = body; this.sent = true; this.emit('finish'); return this; } });
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
const atProvider = out => typeof out.location === 'string' && ['auth', 'registrations'].some(path => out.location.startsWith(ISSUER + '/protocol/openid-connect/' + path + '?'));
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
  const req = { method: 'GET', originalUrl: '/api/studies', url: '/api/studies', route: { path: '/api/studies' }, headers: { authorization: 'Bearer ' + access } };
  try {
    await w.I1.guard.canActivate(new ExecutionContextHost([req, { req }], PacsController, PacsController.prototype.studies));
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
  let sawUncommitted = false;
  w.observe({ inst: 'I1', scope: 'tx', model: 'auditLog', method: 'create', phase: 'after' }, async () => {
    if (sawUncommitted) return;
    assert.equal(await w.base.authSession.count(), 0, 'another connection sees no uncommitted session');
    assert.equal(await w.base.auditLog.count(), 0, 'another connection sees no uncommitted projection');
    sawUncommitted = true;
  });
  const before = new Date();
  const first = await login(w, w.I1, v);
  const after = new Date();
  assert.deepEqual([first.done.status, first.done.location, !!first.done.newSid],
    [302, ORIGIN + '/worklist/hpacs-lite/main.html', true], 'the callback is the one answer that sets kin_sid; the redirect has no entry proof');
  assert.equal(await w.sessions(), 1);
  assert.deepEqual(await w.rows(), [{ actor: 'syn-ma@synthetic.test', action: 'auth.login', target: 'syn-sub-ma',
    detail: { institution: A, ip: IP, dataSubject: null, outcome: 'success' } }]);
  const [stored] = await w.base.auditLog.findMany({ where: { action: 'auth.login', target: 'syn-sub-ma' }, select: { at: true } });
  assert.ok(stored.at instanceof Date, 'the persisted audit time is a Date instant');
  assert.ok(before.getTime() <= stored.at.getTime(), 'the stored login time is not stale');
  assert.ok(stored.at.getTime() <= after.getTime(), 'the stored login time is not in the future');
  assert.ok(stored.at.toISOString().endsWith('Z'), 'the stored login time is a UTC instant');
  assert.equal(sawUncommitted, true);
  const [legal] = await w.base.$queryRaw`SELECT e.payload FROM emr_access.access_entry e
    JOIN emr_access.audit_projection p ON p.event_id=e.event_id
    JOIN "AuditLog" a ON a.id=p.audit_log_id
    JOIN emr_access.attempt_outcome o ON o.operation_id=e.operation_id
    WHERE a.action='auth.login' AND a.target='syn-sub-ma' AND o.outcome='committed'`;
  assert.ok(legal, 'the returned session has a committed legal event and projection');
  const logged = JSON.parse(legal.payload);
  const session = await w.base.authSession.findFirst({ where: { sub: 'syn-sub-ma' } });
  assert.equal(logged.session.value, session.auditRef);
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
  assert.deepEqual([out.status, atProvider(out), out.body, kc.tokens - exchanged, out.consumed], [302, false, undefined, 0, []],
    'restarted at the provider; the pending flow of the other tab is not consumed');
  assert.deepEqual(await last(), failure('state_mismatch'));
  const restarted = 'syn-stray-state';
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
  assert.deepEqual([out.status, atProvider(out), kc.tokens - exchanged], [302, false, 0], 'an expired own flow lands without using its code');
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
    ['signup', undefined, 'syn-sub-s2', {}, 'reauthentication', 'register', 'login'],
    ['switch', SWITCH, 'syn-sub-s3', { lastSeenAt: past(13 * HOUR) }, 'account_switch', undefined, 'login'],
    ['switch', UNFINISHED, 'syn-sub-s4', {}, 'logout', undefined, 'login'],
    ['switch', UNTRUSTED, 'syn-sub-s5', {}, 'reauthentication', 'storage_untrusted', 'login'],
    ['switch', UNREADABLE, 'syn-sub-s6', {}, 'reauthentication', 'record_unreadable', 'login']]) {
    const sid = await w.session(await w.issue(sub, { sub, groups: [B] }), options);
    const out = await w.call(w.I1, kind, { sid, body });
    assert.deepEqual([out.status, out.cookie, atProvider(out)], [200, 'P', true], sub);
    // The provider session was ended and its end confirmed before the address is given: the final step asks for
    // credentials on a form with an editable name (prompt=login), or opens the registration.
    assert.equal(promptOf(out), prompt, sub);
    await w.told();
    assert.ok(kc.ended.includes('syn-idp-' + sub));
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
    assert.deepEqual([out.status, !!out.pending, promptOf(out)], [302, true, 'login']);
    const gone = await w.call(w.I1, 'switch', { sid, body: SWITCH, binding: null });
    assert.deepEqual([gone.status, gone.cookie, promptOf(gone)], [200, 'P', 'login'], 'every new flow requests credentials');
    const signup = await w.call(w.I1, 'signup', { sid, binding: null });
    assert.deepEqual([signup.status, signup.cookie, promptOf(signup)], [200, 'P', 'login']);
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
    await w.told();
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
    assert.deepEqual([rowsOf(await w.rows(), s), kc.endRequests.includes('syn-idp-' + s)], [[], false], kind);
    const retry = await w.call(w.I2, kind, { sid, body });
    assert.deepEqual([retry.status, retry.cookie, await w.version(sid)], [200, 'P', null], kind);
    assert.deepEqual(summary(rowsOf(await w.rows(), s)), [['auth.logout', kind === 'switch' ? 'account_switch' : 'reauthentication', B]], kind);
    // The retry that ended the session left the one end mark, with its cause, and the provider confirmed the end.
    await w.told();
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
    await quiet(w);
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
      w.fault('I1', 'tx.audit', dbError(tag + '-row'));
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
  await w.told(); // Finish the preceding switch's best-effort request before counting this independent logout.
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
      for (const release of kc.hung.splice(0)) release();
      await w.told();
      assert.equal(kc.endRequests.filter(value => value === idpOf(s)).length, 1);

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
  const id1 = deliver(await w.call(w.I1, 'me', { sid: jar })).body.sessionId;
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
  const id2 = deliver(await w.call(w.I2, 'me', { sid: jar })).body.sessionId;
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
  assert.deepEqual(summary(rowsOf(await w.rows(), s)), [['auth.login', 'success', A], ['auth.login', 'success', A], ['auth.logout', 'account_switch', A]]);
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
  run.result = patchMember(admin, m, { enabled: true }, caller)
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


const adminLedgers = new WeakMap();
function makeAdmin(inst, provider) {
  const { AdminService } = require('/app/dist/admin.service');
  const service = new AdminService(inst.prisma, provider, null, inst.service);
  adminLedgers.set(service, createRequestContext(createRequestIngress({proxyPeers:[]}), inst.ledger));
  return service;
}
async function patchMember(admin, sub, body, caller) {
  const requests = adminLedgers.get(admin);
  const req = new http.IncomingMessage(new Socket()), res = new http.ServerResponse(req);
  requests.capture.capture(req,res,{issuer:ISSUER,subject:caller.sub,roles:caller.roles,
    rightsVersion:1,institution:caller.institution ?? A,binding:{method:'bearer',sessionRef:null}},
    {method:'PATCH',route:'admin/users/:id',purpose:'clinical'},async()=>{});
  try {
    return await requests.source.withWork(req,request=>admin.patchUser(sub, body, caller, {
      surface:request.facts.surface,actor:request.facts.actor,
      roles:request.facts.roles,rightsVersion:request.facts.rightsVersion,institution:request.facts.institution,
      ip:null,sessionRef:null,requestId:request.facts.requestId,request }));
  } finally { res.emit('finish'); }
}
const R10_CALLER = { roles: ['admin'], actor: 'syn-r10-admin@synthetic.test', sub: 'syn-r10-admin' };
function r10Admin(w, inst = w.I1) {
  const { AdminService } = require('/app/dist/admin.service');
  return makeAdmin(inst, new KeycloakService());
}
function r10Member(sub, sessions = [], groups = [A], roles = ['radiologist']) {
  kc.members[sub] = { username: sub, email: sub + '@synthetic.test', enabled: true, groups, roles, sessions };
  return sub;
}
const r10Answer = p => p.then(user => ({ status: 200, user }), error => ({ status: error.getStatus?.() ?? 500, body: error.getResponse?.() ?? {} }));
const r10Patch = (admin, sub, body) => r10Answer(patchMember(admin, sub, body, R10_CALLER));
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
  assert.equal(new URL(first.done.location).searchParams.get('auth_error'), 'login_failed');
  const restart = await w.call(w.I2, 'login');
  assert.equal(promptOf(restart), 'login');
  w.tick(1000);
  const token = await w.issue(sub+'-fresh', { sub, groups, authTime: Math.floor(Date.now()/1000) });
  const done = await answerFlow(w, w.I2, restart, token);
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
  await importMemberRights(w.I1.prisma, provider, w.I1.ledger);
  assert.equal(await w.base.memberRights.count(), 5, 'member without session also has a row');
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
  await importMemberRights(w.base, {listUsers:() => {throw new Error('must not reimport authority');}}, w.I1.ledger);
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
  const first=(await login(w,w.I2,token)).done;assert.equal(first.newSid,null);assert.equal(new URL(first.location).searchParams.get('auth_error'),'login_failed');
  const old=(await login(w,w.I2,token)).done;assert.equal(old.newSid,null,'fresh flow does not admit an old authentication time');
  const flow=await w.call(w.I2,'login');
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
  const service=new AuthService(w.I1.prisma,provider,w.I1.ledger,w.I1.background.work); t.after(()=>service.onModuleDestroy());
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
  const restart=new AuthService(w.base,{listUsers:async()=>{calls++;throw Error('must skip provider');}},w.I1.ledger,w.I1.background.work);
  t.after(()=>restart.onModuleDestroy());await restart.onModuleInit();await flush();assert.equal(calls,11);
  const logs=await w.finish('CORE-R2-BOOT');
  assert.ok(logs.some(([,line])=>line.includes('synthetic realm unreachable')),'retry reason is logged');
});

test('CORE-R2-IMPORTED existing realm-v1 starts while the member admin API is down', async t => {
  const w=await world(t);let read=false,calls=0;
  w.observe({inst:'I1',scope:'root',model:'memberRightsImport',method:'findUnique',phase:'after'},()=>{read=true;});
  const service=new AuthService(w.I1.prisma,{listUsers:async()=>{calls++;throw Error('synthetic realm down');}},w.I1.ledger,w.I1.background.work);
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
  assert.equal(before.newSid,null); assert.equal(new URL(before.location).searchParams.get('auth_error'),'login_failed');
  const same=await w.issue(m+'-same',{sub:m,authTime:Math.floor(Date.now()/1000)});
  assert.equal((await login(w,w.I2,same)).done.newSid,null,'fresh same-second authentication is refused');
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

// R8-1 / REQ-S7-U5-DB-RIGHTS -> RISK-PENDING-RESET / SECRET-IN-LOG / RIGHTS-ESCALATION.
for (const mode of ['temp', 'email']) test(`CORE_R8_PENDING_RESET ${mode}: register without granting rights or moving the boundary; one-time secret`, async t => {
  const w = await world(t), sub = r10Member('syn-r8-reset-' + mode), calls = [];
  const { AdminService } = require('/app/dist/admin.service');
  const provider = new KeycloakService();
  provider.resetPassword = async (id, sentMode, password) => { calls.push({ id, mode: sentMode, password }); };
  const admin = makeAdmin(w.I1, provider);
  const reset = caller => r10Answer(admin.resetPassword(sub, { mode }, caller));
  assert.equal((await reset({ actor: 'syn-doctor', roles: ['radiologist'] })).status, 403);
  assert.equal(await w.base.memberRights.count({ where: { sub } }), 0);
  assert.equal(calls.length, 0);
  const before = (await admin.listUsers(1, R10_CALLER)).users.find(row => row.id === sub);
  const result = await reset(R10_CALLER);
  assert.equal(result.status, 200);
  assert.deepEqual([result.user.approvalState, result.user.institution, result.user.roles, result.user.enabled],
    ['PENDING', null, [], true]);
  const stored = await w.base.memberRights.findUnique({ where: { sub } });
  assert.equal(stored.newAuthAfter, null);
  assert.equal(stored.version, 1);
  assert.equal(await w.base.providerChange.count({ where: { sub } }), 0);
  const audit = await w.base.auditLog.findMany({ where: { target: sub, action: 'admin.user.reset-password' } });
  assert.equal(audit.length, 1);
  const detail = JSON.parse(audit[0].detail);
  assert.equal(detail.mode, mode);
  const { rosterUnconfirmed, ...shape } = before;
  assert.deepEqual(detail.before, { ...shape, version: 1 });
  assert.deepEqual(detail.after, detail.before);
  const after = (await admin.listUsers(1, R10_CALLER)).users.find(row => row.id === sub);
  assert.equal('temporaryPassword' in after, false);
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].id, calls[0].mode], [sub, mode]);
  if (mode === 'temp') {
    assert.match(result.user.temporaryPassword, /^[A-Za-z0-9_-]{24}aA1!$/);
    assert.equal(calls[0].password, result.user.temporaryPassword);
    assert.ok(!JSON.stringify(await w.base.auditLog.findMany()).includes(result.user.temporaryPassword));
  } else assert.equal('temporaryPassword' in result.user, false);
  await w.finish('CORE_R8_PENDING_RESET ' + mode);
});

test('CORE_R8_RESET_EXISTING_AND_RACE: reset preserves suspended rights, sessions and boundary; overlapping registrations converge', async t => {
  const w = await world(t), sub = 'syn-r8-existing', { sid } = await coreMember(w, sub);
  const { AdminService } = require('/app/dist/admin.service');
  const provider = new KeycloakService();
  provider.resetPassword = async () => {};
  const make = inst => makeAdmin(inst, provider);
  await w.base.memberRights.update({ where: { sub }, data: { suspended: true, newAuthAfter: new Date(START), version: 9 } });
  const before = await w.base.memberRights.findUnique({ where: { sub } });
  const session = await w.base.authSession.findUnique({ where: { sid } });
  await make(w.I1).resetPassword(sub, { mode: 'temp' }, R10_CALLER);
  assert.deepEqual(await w.base.memberRights.findUnique({ where: { sub } }), before);
  assert.deepEqual(await w.base.authSession.findUnique({ where: { sid } }), session);
  const pending = r10Member('syn-r8-concurrent');
  const held = w.pause({ inst: 'I1', scope: 'tx', model: 'memberRights', method: 'create', phase: 'after' });
  const first = r10Answer(make(w.I1).resetPassword(pending, { mode: 'temp' }, R10_CALLER));
  await held.arrived();
  const second = r10Answer(make(w.I2).resetPassword(pending, { mode: 'email' }, R10_CALLER));
  held.release();
  assert.deepEqual((await Promise.all([first, second])).map(r => r.status), [200, 200]);
  assert.equal(await w.base.memberRights.count({ where: { sub: pending } }), 1);
  assert.equal((await w.base.memberRights.findUnique({ where: { sub: pending } })).newAuthAfter, null);
  assert.equal(await w.base.auditLog.count({ where: { target: pending, action: 'admin.user.reset-password' } }), 2);
  assert.equal(await w.base.providerChange.count(), 0);
  await w.finish('CORE_R8_RESET_EXISTING_AND_RACE');
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
    if(path==='hasSession')return w.call(w.I2,'login',{sid});
    if(path==='authenticateSession')return r10Answer(w.I2.service.authenticateSession(sid,{}));
    return w.call(w.I2,'get',{sid});
  };
  return {...setup,sid,done,run};
}
for(const path of ['callback','refresh','hasSession'])test(`CORE_ENTRY_MISSING_ROW U5 ${path}`,async t=>{
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
for(const path of ['callback','refresh','document','authenticateSession','hasSession'])test(`CORE_ENTRY_DB_DOWN U6 ${path}`,async t=>{
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

test('CORE_CREDENTIALS_COMMIT_CRASH_SECOND_API U8 intent survives shutdown before publication; another API admits DB rights',async t=>{
  const w=await world(t),m='syn-crash-credentials',{admin}=await coreMember(w,m);
  let crashed=false;w.observe({inst:'I1',model:'$transaction',phase:'after'},e=>{
    if(e.result?.change?.kind==='credentials'&&!crashed){crashed=true;w.I1.background.quiesce();}
  });
  assert.equal((await r10Patch(admin,m,coreBody('Change'))).status,200);assert.equal(crashed,true);
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
  assert.equal((await coreRoster(w,m)).rosterUnconfirmed,true,'the late older completion is visible');
  const {retryMemberRoster}=require('/app/dist/member-rights-import');w.tick(1000);
  assert.deepEqual(await retryMemberRoster(w.I2.prisma,new KeycloakService()),{attempted:1,unconfirmed:0,superseded:0,overlaps:1});
  assert.deepEqual(kc.members[m].groups,[Z]);assert.equal((await coreRoster(w,m)).rosterUnconfirmed,false);
  assert.deepEqual(await retryMemberRoster(w.I2.prisma,new KeycloakService()),{attempted:0,unconfirmed:0,superseded:0,overlaps:0});
  assert.equal(kc.endRequests.length,0);await w.finish('U9');
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

for(const path of ['callback','refresh'])test(`CORE_ENTRY_MEMBER_LOCK_TIMEOUT U13 ${path}`,async t=>{
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
  const flow=await w.call(w.I1,'switch',{body:SWITCH});assert.equal(promptOf(flow),'login');
  const refused=await answerFlow(w,w.I1,flow,token);
  if(blocked==='missing'){
    assert.ok(refused.newSid);
    const me=await w.call(w.I1,'me',{sid:refused.newSid});
    assert.deepEqual([me.status,me.body.code],[403,'INSTITUTION_PENDING']);
  }else assert.equal(refused.newSid,null);
  const fresh=await w.call(w.I1,'login');
  const b=await w.issue(m+'-b',{sub:m+'-b',idp:m+'-b-sso'});
  const entered=await answerFlow(w,w.I1,fresh,b);assert.ok(entered.newSid);
  assert.equal((await w.call(w.I1,'me',{sid:entered.newSid})).body.sub,b.sub);await w.finish('O2 '+blocked);
});

test('CORE_FRESH RV-02 rights changed enters after one credential prompt',async t=>{
  const w=await world(t),m='syn-fresh-rights',{admin}=await coreMember(w,m);
  assert.equal((await r10Patch(admin,m,coreBody('Change'))).status,200);await quiet(w);
  const fresh=await w.call(w.I1,'switch',{body:SWITCH});
  assert.equal(promptOf(fresh),'login');w.tick(1000);
  const next=await w.issue(m+'-fresh',{sub:m,idp:m+'-new-sso',authTime:Math.floor(Date.now()/1000)});
  const entered=await answerFlow(w,w.I1,fresh,next);assert.ok(entered.newSid,'first fresh authentication enters');
  assert.equal(atProvider(entered),false,'no second credential prompt');await w.finish('RV-02');
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
    assert.ok(done.newSid);
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

test('CORE_ROSTER_STATUS RV-04 commands without a new credentials record preserve the latest roster outcome',async t=>{
  const w=await world(t),m='syn-roster-note',{admin}=await coreMember(w,m);
  assert.equal((await r10Patch(admin,m,coreBody('Change'))).status,200);await coreSettled(w,m);
  assert.equal((await coreRoster(w,m)).rosterUnconfirmed,false);w.tick(1000);
  const suspend=await r10Patch(admin,m,coreBody('Suspend'));assert.equal(suspend.status,200);assert.equal(suspend.user.rosterUnconfirmed,false);
  assert.equal((await coreRoster(w,m)).rosterUnconfirmed,false);w.tick(1000);
  assert.equal((await r10Patch(admin,m,coreBody('Activate'))).status,200);await coreSettled(w,m);
  assert.equal((await coreRoster(w,m)).rosterUnconfirmed,false);w.tick(1000);
  assert.equal((await r10Patch(admin,m,coreBody('Cancel'))).status,200);assert.equal((await coreRoster(w,m)).rosterUnconfirmed,false);
  await w.finish('RV-04');
});

test('CORE_HASSESSION RV-05 refused or stale-version cookie starts login; unrelated callback never answers work',async t=>{
  const w=await world(t),m='syn-hassession',{sid}=await coreMember(w,m);
  for(const patch of [{suspended:true},{suspended:false,version:2}]){
    await w.base.memberRights.update({where:{sub:m},data:patch});
    assert.equal(atProvider(await w.call(w.I1,'login',{sid})),true,'refused cookie must start a flow');
    const stray=await w.call(w.I1,'callback',{sid,query:{code:'unowned',state:'unowned'}});
    assert.equal(new URL(stray.location).searchParams.get('auth_error'),'stale','unowned state cannot answer work');assert.equal(stray.newSid,null);
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
  await require('/app/dist/member-rights-import').importMemberRights(w.I1.prisma,{listUsers:async()=>({total:users.length,users})},w.I1.ledger);
  for(const token of tokens){
    assert.equal((await w.call(w.I1,'get',{bearer:token.access})).status,401);
    const old=(await login(w,w.I2,token)).done;
    assert.equal(old.newSid,null);assert.equal(new URL(old.location).searchParams.get('auth_error'),'login_failed','old authentication cannot enter');
    assert.equal(await w.base.authSession.count({where:{sub:token.sub,rightsVersion:1}}),0);
  }
  await w.finish('O1');
});


test('CORE_REALM_404 a realm read 404 is a failed import, never a ready empty realm',async t=>{
  const w=await world(t,{imported:false});kc.realmReadStatus=404;
  await assert.rejects(require('/app/dist/member-rights-import').importMemberRights(w.I1.prisma,new KeycloakService(),w.I1.ledger),e=>e.getStatus?.()===503);
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
  const provider={listUsers:async page=>({page,pageSize:2,total:users.length,realmUsers:users,users:users.slice((page-1)*2,page*2)})};
  const {AdminService}=require('/app/dist/admin.service'),admin=makeAdmin(w.I1,provider);
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
  const first=importMemberRights(w.I1.prisma,provider,w.I1.ledger),second=importMemberRights(w.I2.prisma,provider,w.I2.ledger);
  await within(arrived.promise,'both APIs read the missing marker');release.resolve();await Promise.all([first,second]);
  await coreSettled(w,m);const marker=await w.base.memberRightsImport.findUnique({where:{id:'realm-v1'}});
  assert.equal(commits,1);assert.equal(sends,1);assert.equal(await w.base.memberRightsImport.count(),1);
  assert.equal(await w.base.providerChange.count({where:{sub:m,kind:'credentials'}}),1);
  const row=await w.base.memberRights.findUnique({where:{sub:m}});assert.equal(row.suspended,true);assert.equal(row.newAuthAfter.getTime(),marker.completedAt.getTime());
  await importMemberRights(w.I1.prisma,provider,w.I1.ledger);assert.equal(readers,2);assert.equal(sends,1);await w.finish('CORE_IMPORT_TWO_INSTANCES');
});

for(const cut of ['503','crash','404','held'])test(`CORE_LEGACY_DISABLED_RECOVERY_503_CRASH_LATE_DISABLE ${cut}`,async t=>{
  const w=await world(t,{imported:false}),m=r10Member('syn-legacy-'+cut);kc.members[m].enabled=false;kc.members[m].emailVerified=true;
  const {importMemberRights,retryMemberRoster}=require('/app/dist/member-rights-import'),provider=new KeycloakService();
  const held=deferred(),arrived=deferred(),shutdown=new AbortController();t.after(()=>held.resolve());let crashed=false;
  if(cut==='crash')w.observe({inst:'I1',model:'$transaction',phase:'after'},()=>{if(!crashed){crashed=true;shutdown.abort();}});
  kc.beforeAdmin=async(name,sub)=>{if(name!=='PUT enable'||sub!==m)return;
    assert.equal(await w.base.memberRightsImport.count(),1);assert.equal((await w.base.memberRights.findUnique({where:{sub:m}})).suspended,true);
    if(cut==='held'){arrived.resolve();await held.promise;}else if(cut==='503')return 503;else if(cut==='404')return 404;
  };
  if(cut==='crash'){await importMemberRights(w.I1.prisma,provider,w.I1.ledger,shutdown.signal);assert.equal(shutdown.signal.aborted,true);}
  else await importMemberRights(w.I1.prisma,provider,w.I1.ledger);
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
  assert.deepEqual(await retryMemberRoster(w.I2.prisma,new KeycloakService()),{attempted:1,unconfirmed:0,superseded:0,overlaps:0});
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

// D638 R9 / REQ-S7-U5-DB-RIGHTS -> RISK-STALE-ROSTER / FALSE-STATUS / IDENTITY-REWIND.
for (const olderState of ['unknown','void']) for (const newerState of ['done','unknown','void'])
test(`CORE_R9_RETRY_NEWEST ${olderState}->${newerState}: supersede old intents and send only the latest`,async t=>{
  const w=await world(t),m='syn-r9-retry',{admin}=await coreMember(w,m);
  const {retryMemberRoster}=require('/app/dist/member-rights-import');
  let armed=false;
  w.observe({inst:'I1',scope:'tx',model:'providerChange',method:'create',phase:'after'},()=>{armed=true;});
  const fail=state=>name=>armed&&name==='GET groups'?(state==='void'?404:503):undefined;
  kc.beforeAdmin=fail(olderState);
  assert.equal((await r10Patch(admin,m,{institution:B,roles:['clinician']})).status,200);
  await coreSettled(w,m);
  armed=false;kc.beforeAdmin=newerState==='done'?null:fail(newerState);
  assert.equal((await r10Patch(admin,m,{institution:A,roles:['radiologist']})).status,200);
  await coreSettled(w,m);kc.beforeAdmin=null;
  const records=await w.base.providerChange.findMany({where:{sub:m,kind:'credentials'},orderBy:{id:'asc'}});
  assert.deepEqual(records.map(r=>r.state),[olderState,newerState]);
  assert.equal((await coreRoster(w,m)).rosterUnconfirmed,newerState!=='done','only the latest outcome decides the label, including void');
  const rights=await w.base.memberRights.findUnique({where:{sub:m}}),sends=[];
  const provider=new KeycloakService(),groups=provider.setGroups.bind(provider),roles=provider.setRoles.bind(provider);
  provider.setGroups=async(sub,value)=>{sends.push(['groups',sub,value]);return groups(sub,value);};
  provider.setRoles=async(sub,value)=>{sends.push(['roles',sub,value]);return roles(sub,value);};
  assert.deepEqual(await retryMemberRoster(w.I2.prisma,provider),{attempted:newerState==='done'?0:1,unconfirmed:0,superseded:1,overlaps:0});
  assert.deepEqual(sends,newerState==='done'?[]:[['groups',m,[A]],['roles',m,['radiologist']]]);
  assert.deepEqual([kc.members[m].groups,kc.members[m].roles],[[A],['radiologist']]);
  const old=await w.base.providerChange.findUnique({where:{id:records[0].id}});
  assert.equal(old.outcome,'superseded');assert.ok(old.settledAt);
  assert.equal((await coreRoster(w,m)).rosterUnconfirmed,false);
  assert.deepEqual(await retryMemberRoster(w.I2.prisma,provider),{attempted:0,unconfirmed:0,superseded:0,overlaps:0});
  assert.deepEqual(await w.base.memberRights.findUnique({where:{sub:m}}),rights);
  await w.finish('CORE_R9_RETRY_NEWEST');
});

test('CORE_R9_LIST_ONE_SCAN page selection never multiplies realm admin requests',async t=>{
  const w=await world(t),provider=new KeycloakService(),calls=[];
  const members=Array.from({length:60},(_,i)=>({id:'syn-r9-list-'+i,username:'u'+i,email:'u'+i+'@synthetic.test',enabled:true,emailVerified:true}));
  provider.adm=async(route,method='GET')=>{
    calls.push([method,route]);assert.equal(method,'GET');
    if(route.startsWith('/users?'))return members;
    const user=members.find(u=>route==='/users/'+u.id);if(user)return user;
    if(route.includes('/groups?')||route.endsWith('/role-mappings/realm'))return [];
    assert.fail('unexpected admin request '+route);
  };
  const {AdminService}=require('/app/dist/admin.service'),admin=makeAdmin(w.I1,provider);
  const before=await w.base.memberRights.findMany();
  for(const page of [1,2,3,4]){
    calls.length=0;const result=await admin.listUsers(page,R10_CALLER);
    assert.equal(calls.filter(([,route])=>route.startsWith('/users?')).length,1,'one brief realm scan');
    assert.equal(calls.length,181,'one scan plus three detail requests per member, independent of page');
    assert.equal(result.total,60);assert.equal(result.pendingCount,60);
    assert.equal(result.users.length,[25,25,10,0][page-1]);
    assert.equal('realmUsers' in result,false,'internal full list is not exposed on the paginated API');
  }
  assert.deepEqual(await w.base.memberRights.findMany(),before);
  assert.equal(await w.base.providerChange.count(),0);
  await w.finish('CORE_R9_LIST_ONE_SCAN');
});

for(const command of ['Approve','Change','Suspend','Activate','ResetTemp','ResetEmail'])
test(`CORE_R9_IDENTITY_COMMAND ${command}: only a command refreshes current provider identity`,async t=>{
  const w=await world(t),m='syn-r9-identity',setup=await coreSetup(w,m,command),provider=new KeycloakService();
  const {AdminService}=require('/app/dist/admin.service');provider.resetPassword=async()=>{};
  const admin=makeAdmin(w.I1,provider);
  const before=await w.base.memberRights.findUnique({where:{sub:m}});
  Object.assign(kc.members[m],{username:'renamed',email:'renamed@synthetic.test',firstName:'Given',lastName:'Family',emailVerified:command==='Approve'});
  assert.equal((await coreRoster(w,m)).email,before.email,'GET cannot refresh a registered row');
  assert.deepEqual(await w.base.memberRights.findUnique({where:{sub:m}}),before);
  if(command.startsWith('Reset'))await admin.resetPassword(m,{mode:command==='ResetTemp'?'temp':'email'},R10_CALLER);
  else assert.equal((await r10Patch(admin,m,{...coreBody(command),verificationOverride:command==='Change'?true:undefined})).status,200);
  const row=await coreRoster(w,m);
  assert.deepEqual([row.username,row.email,row.name,row.emailVerified],command.startsWith('Reset')
    ? [before.username,before.email,before.name,before.emailVerified] : ['renamed','renamed@synthetic.test','Family Given',command==='Approve']);
  if(command.startsWith('Reset'))assert.deepEqual([row.version,row.roles,row.enabled],[before.version,before.roles,!before.suspended]);
  await w.finish('CORE_R9_IDENTITY_COMMAND '+command);
});

test('CORE_R9_IDENTITY_FORWARD: an older pre-read loses CAS and cannot rewind a committed command identity',async t=>{
  const w=await world(t),m='syn-r10-forward';await coreMember(w,m);
  const {AdminService}=require('/app/dist/admin.service'),provider=new KeycloakService();
  const original=provider.getUser.bind(provider),arrived=deferred(),release=deferred();let reads=0;
  t.after(()=>release.resolve());
  provider.getUser=async(...args)=>{const result=await original(...args);if(++reads===1){arrived.resolve();await release.promise;}return result;};
  const admin=inst=>makeAdmin(inst,provider);
  const first=r10Patch(admin(w.I1),m,coreBody('Change'));await within(arrived.promise,'older identity captured');
  Object.assign(kc.members[m],{email:'newest@synthetic.test',firstName:'Newest',lastName:'Identity'});
  let second;
  try { second=await within(r10Patch(admin(w.I2),m,coreBody('Change')),'newer command never waits on remote I/O under lock'); }
  finally { release.resolve(); }
  const older=await first;assert.equal(second.status,200);assert.equal(older.status,409);assert.equal(older.body.code,'MEMBER_VERSION_CONFLICT');
  const row=await coreRoster(w,m);assert.deepEqual([row.email,row.name],['newest@synthetic.test','Identity Newest']);
  assert.equal(await w.base.providerChange.count({where:{sub:m}}),1);
  await quiet(w);await w.finish('CORE_R9_IDENTITY_FORWARD');
});

test('CORE_COMMAND_DB_CLOCK rights boundary uses transaction DB time despite application clock skew',async t=>{
  const w=await world(t),m='syn-db-clock',{admin}=await coreMember(w,m);w.realDatabaseClock=true;let dbTime;
  const appClockSkew=7*24*HOUR;
  w.observe({inst:'I1',model:'$transaction',phase:'started'},async e=>{
    dbTime=(await e.client.$queryRaw`SELECT now() AS boundary`)[0].boundary;
    // Anchor the skew to this transaction, not START: wall time can coincide with START + seven days.
    // setTime changes Date without firing the hourly sweep while this transaction is open.
    if(realPG())t.mock.timers.setTime(dbTime.getTime()+appClockSkew);
  });
  assert.equal((await r10Patch(admin,m,{enabled:false})).status,200);
  const row=await w.base.memberRights.findUnique({where:{sub:m}});assert.equal(row.newAuthAfter.getTime(),dbTime.getTime());
  if(realPG())assert.ok(Math.abs(row.newAuthAfter.getTime()-Date.now())>HOUR,'database and application clocks were independently exercised');
  if(realPG())assert.equal(Date.now()-dbTime.getTime(),appClockSkew,'application clock has the fixed skew from the transaction boundary');
  await w.finish('CORE_COMMAND_DB_CLOCK');
});

// D640: REQ-S7-U5-DB-RIGHTS/AUDIT -> RISK-REFUSAL-AUDIT/REMOTE-LOCK/IDENTITY-REWIND -> CORE_R10 / ASTRA below.
test('CORE_R10_UNVERIFIED refusal precedes the command: 400, zero audit or rights change; override is the sole audited bypass',async t=>{
  const w=await world(t),m='syn-r10-unverified',{admin}=await coreSetup(w,m,'Approve');
  kc.members[m].emailVerified=false;const before=await w.base.memberRights.findUnique({where:{sub:m}});
  const refused=await r10Patch(admin,m,coreBody('Approve'));assert.equal(refused.status,400);
  assert.equal(await w.base.auditLog.count({where:{target:m}}),0);
  assert.deepEqual(await w.base.memberRights.findUnique({where:{sub:m}}),before);
  assert.equal(await w.base.providerChange.count(),0);
  const allowed=await r10Patch(admin,m,{...coreBody('Approve'),verificationOverride:true});assert.equal(allowed.status,200);
  const rows=await w.base.auditLog.findMany({where:{target:m,action:'admin.user.approve'}});
  assert.equal(rows.length,1);assert.equal(JSON.parse(rows[0].detail).verificationOverride,true);
  await coreSettled(w,m);await w.finish('CORE_R10_UNVERIFIED');
});

// RV5-01: REQ-S7-U5-DB-RIGHTS -> RISK-UNVALIDATED-INSTITUTION / REFUSAL-AUDIT.
test('CORE_INSTITUTION_ONLY_OUTAGE_NO_CONFLICT', async t => {
  const w = await world(t);
  for (const command of ['Approve', 'Change']) for (const refusal of ['outage', 'absent']) {
    const m = 'syn-institution-only-' + command + '-' + refusal;
    const { admin } = await coreMember(w, m); // Already approved, with a live session; no competing command.
    const rights = await w.base.memberRights.findUnique({ where: { sub: m } });
    const sessions = await w.base.authSession.findMany({ where: { sub: m } });
    assert.equal(rights.approved, true); assert.equal(sessions.length, 1);
    kc.institutionsDown = refusal === 'outage';
    // The identity endpoints remain healthy while ONLY /groups fails.
    assert.equal((await new KeycloakService().getUser(m)).id, m);
    const reads = kc.institutionReads, calls = kc.adminCalls.length;
    const result = await r10Patch(admin, m, { ...coreBody(command),
      institution: refusal === 'absent' ? 'syn-institution-not-listed' : B });
    assert.equal(result.status, refusal === 'outage' ? 503 : 400, command + '/' + refusal);
    assert.equal(kc.institutionReads, reads + 1, 'the command consulted the institution list');
    await quiet(w);
    assert.deepEqual(await w.base.memberRights.findUnique({ where: { sub: m } }), rights);
    assert.deepEqual(await w.base.authSession.findMany({ where: { sub: m } }), sessions);
    assert.equal(await w.base.auditLog.count(), 0, 'input refusal creates no audit, including failure audits');
    assert.equal(await w.base.providerChange.count(), 0, 'no roster/credentials intent');
    assert.ok(kc.adminCalls.slice(calls).every(call => call.startsWith('GET ')), 'no provider publication');
    assert.equal(kc.endRequests.length, 0); assert.equal(kc.userLogouts.length, 0);
    kc.institutionsDown = false;
  }
  await w.finish('CORE_INSTITUTION_ONLY_OUTAGE_NO_CONFLICT');
});

for(const command of CORE_COMMANDS)test(`ASTRA_KC_DOWN ${command}: outage never blocks DB revocation or activation`,async t=>{
  const w=await world(t),m='syn-r10-outage-'+command,{admin,sid}=await coreSetup(w,m,command);
  const before=await w.base.memberRights.findUnique({where:{sub:m}});kc.adminDown=true;
  const result=await r10Patch(admin,m,coreBody(command));kc.adminDown=false;
  if(['Approve','Change'].includes(command)){
    assert.equal(result.status,503);assert.deepEqual(await w.base.memberRights.findUnique({where:{sub:m}}),before);
    assert.ok(await w.base.authSession.findUnique({where:{sid}}));assert.equal(await w.base.auditLog.count({where:{target:m}}),0);
  }else{
    assert.equal(result.status,200);const after=await w.base.memberRights.findUnique({where:{sub:m}});
    assert.equal(after.version,before.version+1);assert.equal(after.suspended,command!=='Activate');
    if(command==='Cancel'){assert.equal(after.approved,false);assert.deepEqual(after.roles,[]);assert.equal(after.institution,null);}
    assert.equal(await w.base.authSession.count({where:{sub:m}}),0);
    assert.equal(await w.base.auditLog.count({where:{target:m,action:'auth.logout'}}),1);
    assert.equal(await w.base.auditLog.count({where:{target:m,action:'admin.user.'+({Suspend:'suspend',Cancel:'unapprove',Activate:'activate'}[command])}}),1);
  }
  assert.equal(await w.base.providerChange.count(),0);await w.finish('ASTRA_KC_DOWN '+command);
});

test('ASTRA_CAS_KC_DOWN stale observed command is 409 without extra end or publication',async t=>{
  const w=await world(t),m='syn-r10-cas-down',{admin}=await coreMember(w,m);
  const hold=w.pause({inst:'I2',scope:'root',model:'memberRights',method:'findUnique',phase:'after'});
  const loser=r10Patch(r10Admin(w,w.I2),m,coreBody('Cancel'));await hold.arrived();
  assert.equal((await r10Patch(admin,m,coreBody('Suspend'))).status,200);kc.adminDown=true;hold.release();
  const result=await loser;kc.adminDown=false;assert.equal(result.status,409);assert.equal(result.body.code,'MEMBER_VERSION_CONFLICT');
  assert.equal(await w.base.auditLog.count({where:{target:m,action:'auth.logout'}}),1);
  assert.equal(await w.base.auditLog.count({where:{target:m,action:'admin.user.unapprove'}}),0);
  assert.equal(await w.base.providerChange.count(),0);await w.finish('ASTRA_CAS_KC_DOWN');
});

for(const path of ['callback','refresh'])test(`CORE_R10_REMOTE_UNLOCKED ${path} completes while a command pre-read is held`,async t=>{
  const w=await world(t),m='syn-r10-entry-'+path,f=await coreEntry(w,path,m);
  const {AdminService}=require('/app/dist/admin.service'),provider=new KeycloakService(),original=provider.getUser.bind(provider);
  const arrived=deferred(),release=deferred();t.after(()=>release.resolve());
  provider.getUser=async(...args)=>{const result=await original(...args);arrived.resolve();await release.promise;return result;};
  const command=r10Patch(makeAdmin(w.I1,provider),m,coreBody('Change'));
  await within(arrived.promise,'pre-read captured');let out;
  try{
    const entry=f.run();
    if(path==='refresh'){
      const exchange=await heldToken(1,'I2');exchange.answer(reply.tokens(await w.issue(m+'-refreshed',{sub:m})));
    }
    out=await within(entry,'entry cannot wait for a remote read holding the member lock');
  }
  finally{release.resolve();await command;}
  if(path==='callback')assert.ok(out.newSid);else assert.equal(out.status,200);
  await quiet(w);await w.finish('CORE_R10_REMOTE_UNLOCKED '+path);
});

test('CORE_R10_RESET_BUSY reset under member contention returns 409 MEMBER_BUSY with no password call',async t=>{
  const w=await world(t),m='syn-r10-reset-lock';await coreMember(w,m);
  const {AdminService}=require('/app/dist/admin.service'),provider=new KeycloakService();let sent=0,release,held;
  provider.resetPassword=async()=>{sent++;};
  const before=await w.base.memberRights.findUnique({where:{sub:m}});
  if(realPG()){
    const arrived=deferred();release=deferred();t.after(()=>release.resolve());
    held=w.base.$transaction(async tx=>{await require('/app/dist/member-rights').lockMemberRights(tx,m);arrived.resolve();await release.promise;},{timeout:15000});
    await arrived.promise;
  }else w.observe({inst:'I1',model:'$executeRaw',phase:'before'},e=>{
    if(e.args[1]===0x4b494e4d)throw Object.assign(Error('synthetic timeout'),{code:'P2010',meta:{code:'55P03'}});
  });
  const result=await r10Answer(makeAdmin(w.I1,provider).resetPassword(m,{mode:'email'},R10_CALLER));
  release?.resolve();if(held)await held;
  assert.equal(result.status,409);assert.equal(result.body.code,'MEMBER_BUSY');assert.equal(sent,0);
  assert.deepEqual(await w.base.memberRights.findUnique({where:{sub:m}}),before);await w.finish('CORE_R10_RESET_BUSY');
});

test('CORE_R10_LEGACY_LABEL a confirmed ordinary publication cannot hide an uncertain legacy enable',async t=>{
  const w=await world(t),m='syn-r10-legacy-label',{admin}=await coreMember(w,m);
  for(const state of ['unknown','void']){
    const legacy=await w.base.providerChange.create({data:{kind:'credentials',sub:m,target:'legacy-enable:'+m,generation:1,state,createdAt:new Date()}});
    assert.equal((await r10Patch(admin,m,coreBody('Change'))).status,200);await coreSettled(w,m);
    assert.equal((await coreRoster(w,m)).rosterUnconfirmed,true);
    await w.base.providerChange.update({where:{id:legacy.id},data:{state:'done',settledAt:new Date()}});
    assert.equal((await coreRoster(w,m)).rosterUnconfirmed,false);
  }
  await w.finish('CORE_R10_LEGACY_LABEL');
});

test('CORE_R10_IMPORT_DESIGNATION binds unique legacy P subjects atomically, preserving ambiguous and unmatched nulls',async t=>{
  const w=await world(t,{imported:false});
  const users=[['syn-bind-one','one@synthetic.test'],['syn-bind-two','duplicate@synthetic.test'],['syn-bind-three','duplicate@synthetic.test']]
    .map(([id,email])=>({id,email,username:id,emailVerified:true,enabled:true,groups:[A],roles:['radiologist']}));
  const ids=['2.25.710001','2.25.710002'];
  t.after(async()=>{for(const uid of ids)await w.base.studyState.deleteMany({where:{uid}});});
  await w.base.studyState.create({data:{uid:ids[0],rs:'P',preDoc:'one@synthetic.test',preReviewer:'duplicate@synthetic.test'}});
  await w.base.studyState.create({data:{uid:ids[1],rs:'P',preDoc:'unmatched@synthetic.test',preReviewer:'one@synthetic.test'}});
  const {importMemberRights}=require('/app/dist/member-rights-import');
  await importMemberRights(w.I1.prisma,{listUsers:async()=>({total:users.length,users})},w.I1.ledger);
  const one=await w.base.studyState.findUnique({where:{uid:ids[0]}}),two=await w.base.studyState.findUnique({where:{uid:ids[1]}});
  assert.deepEqual([one.preDocSub,one.preReviewerSub,two.preDocSub,two.preReviewerSub],['syn-bind-one',null,null,'syn-bind-one']);
  assert.equal(await w.base.memberRightsImport.count(),1);
  await importMemberRights(w.I2.prisma,{listUsers:async()=>assert.fail('marker prevents a second import')},w.I2.ledger);
  assert.deepEqual(await w.base.studyState.findUnique({where:{uid:ids[0]}}),one);
  await w.finish('CORE_R10_IMPORT_DESIGNATION');
});

test('CORE_R10_RESET_FORWARD a delayed reset pre-read cannot hold a member lock or refresh an existing identity',async t=>{
  const w=await world(t),m='syn-r10-reset-forward';await coreMember(w,m);
  const {AdminService}=require('/app/dist/admin.service'),provider=new KeycloakService(),original=provider.getUser.bind(provider);
  const arrived=deferred(),release=deferred();let reads=0;t.after(()=>release.resolve());provider.resetPassword=async()=>{};
  provider.getUser=async(...args)=>{const result=await original(...args);if(++reads===1){arrived.resolve();await release.promise;}return result;};
  const admin=inst=>makeAdmin(inst,provider);
  const reset=r10Answer(admin(w.I1).resetPassword(m,{mode:'email'},R10_CALLER));await within(arrived.promise,'reset identity captured');
  Object.assign(kc.members[m],{email:'after-reset-read@synthetic.test',firstName:'Newest',lastName:'Identity'});
  let change,before;
  try{change=await within(r10Patch(admin(w.I2),m,coreBody('Change')),'command proceeds while reset awaits the provider');before=await w.base.memberRights.findUnique({where:{sub:m}});}
  finally{release.resolve();}
  assert.equal((await reset).status,200);assert.equal(change.status,200);
  assert.deepEqual(await w.base.memberRights.findUnique({where:{sub:m}}),before,'reset never rewrites identity, version, rights, or boundary');
  assert.equal(before.email,'after-reset-read@synthetic.test');await quiet(w);await w.finish('CORE_R10_RESET_FORWARD');
});

for(const command of ['Suspend','Cancel','Activate'])test(`CORE_R10_KC_HANG ${command} does not wait for a provider answer`,async t=>{
  const w=await world(t),m='syn-r10-hang-'+command,{admin}=await coreSetup(w,m,command),release=deferred();
  t.after(()=>release.resolve());let held=false;
  kc.beforeAdmin=(name,sub)=>{if(sub===m&&name==='GET read'){held=true;return release.promise;}};
  let result;try{result=await within(r10Patch(admin,m,coreBody(command)),'DB command bounds an optional identity read',2500);}
  finally{release.resolve();}
  assert.equal(held,true);assert.equal(result.status,200);assert.equal(await w.base.authSession.count({where:{sub:m}}),0);
  await quiet(w);await w.finish('CORE_R10_KC_HANG '+command);
});

test('CORE_R10_LATE_SUPERSEDED a publication answered after retry remains visible and can be repaired',async t=>{
  const w=await world(t),m='syn-r10-late-superseded',{admin}=await coreMember(w,m),arrived=deferred(),release=deferred();let once=true;
  const {retryMemberRoster}=require('/app/dist/member-rights-import');t.after(()=>release.resolve());
  kc.beforeAdmin=(name,sub)=>{if(once&&sub===m&&name==='PUT groups/syn-group-'+B){once=false;arrived.resolve();return release.promise;}};
  assert.equal((await r10Patch(admin,m,{institution:B,roles:['radiologist']})).status,200);await within(arrived.promise,'older publish held');
  w.tick(1000);assert.equal((await r10Patch(r10Admin(w,w.I2),m,{institution:Z,roles:['technician']})).status,200);await coreSettled(w,m);
  const old=await w.base.providerChange.findFirst({where:{sub:m},orderBy:{id:'asc'}});
  assert.deepEqual(await retryMemberRoster(w.I2.prisma,new KeycloakService()),{attempted:0,unconfirmed:0,superseded:1,overlaps:0});
  w.tick(1000);release.resolve();await quiet(w);
  assert.equal((await w.base.providerChange.findUnique({where:{id:old.id}})).state,'done','late completion must not disappear behind superseded');
  assert.equal((await coreRoster(w,m)).rosterUnconfirmed,true);w.tick(1000);
  assert.deepEqual(await retryMemberRoster(w.I2.prisma,new KeycloakService()),{attempted:1,unconfirmed:0,superseded:0,overlaps:1});
  assert.deepEqual(kc.members[m].groups,[Z]);assert.equal((await coreRoster(w,m)).rosterUnconfirmed,false);
  assert.equal((await retryMemberRoster(w.I2.prisma,new KeycloakService())).attempted,0);await w.finish('CORE_R10_LATE_SUPERSEDED');
});

// D642: REQ-S7-U5-DB-RIGHTS -> RISK-CAS-OUTAGE / REFUSAL-AUDIT -> CORE_R11.
// Each cell separately fails the institution and identity pre-read after the winner commits.
for (const first of CORE_COMMANDS) for (const second of CORE_COMMANDS)
test(`CORE_R11_CAS_OUTAGE_MATRIX ${first}->${second}`, async t => {
  const w = await world(t);
  for (const failure of ['institution', 'identity']) {
    const m = 'syn-r11-outage-' + first + '-' + second + '-' + failure;
    const { admin } = await coreMember(w, m);
    const provider = new KeycloakService();
    const { AdminService } = require('/app/dist/admin.service');
    const contender = makeAdmin(w.I2, provider);
    const held = w.pause({ inst: 'I2', scope: 'root', model: 'memberRights', method: 'findUnique', phase: 'after' });
    const loser = r10Patch(contender, m, coreBody(second)); await held.arrived();
    assert.equal((await r10Patch(admin, m, coreBody(first))).status, 200);
    if (['Approve', 'Change'].includes(first)) await coreSettled(w, m);
    if (['Approve', 'Change', 'Activate'].includes(first)) await coreFresh(w, m);
    const rights = await w.base.memberRights.findUnique({ where: { sub: m } });
    const sessions = await w.base.authSession.findMany({ where: { sub: m } });
    assert.equal(sessions.length, ['Approve', 'Change', 'Activate'].includes(first) ? 1 : 0, 'a fresh winner session makes preservation observable');
    const publications = await w.base.providerChange.findMany({ where: { sub: m } });
    const successfulAudits = async () => (await w.base.auditLog.findMany({ where: { target: m } }))
      .filter(row => row.action !== 'admin.user.patch.failed');
    const audits = await successfulAudits();
    let reached = 0;
    provider[failure === 'institution' ? 'institutions' : 'getUser'] = async () => {
      reached++; throw new (require('/app/node_modules/@nestjs/common').ServiceUnavailableException)('Synthetic provider outage');
    };
    held.release(); const result = await loser;
    assert.equal(result.status, 409, failure); assert.equal(result.body.code, 'MEMBER_VERSION_CONFLICT');
    if (['Approve', 'Change'].includes(second)) assert.equal(reached, 1, failure + ' was injected');
    assert.deepEqual(await w.base.memberRights.findUnique({ where: { sub: m } }), rights);
    assert.deepEqual(await w.base.authSession.findMany({ where: { sub: m } }), sessions);
    assert.deepEqual(await w.base.providerChange.findMany({ where: { sub: m } }), publications);
    assert.deepEqual(await successfulAudits(), audits);
  }
  await w.finish('CORE_R11_CAS_OUTAGE_MATRIX');
});

test('PC3 login uses prompt=login and PKCE; bound logout needs no CSRF header', async t => {
  const w = await world(t);
  const start = await w.call(w.I1, 'login');
  const query = new URL(start.location).searchParams;
  assert.equal(query.get('prompt'), 'login');
  assert.equal(query.get('code_challenge_method'), 'S256');
  assert.ok(query.get('code_challenge'));
  const token = await w.issue('pc3-one', { sub: 'syn-pc3-doctor' });
  const first = await login(w, w.I1, token);
  assert.equal((await w.call(w.I1, 'logout', { sid: first.done.newSid, csrf: false })).status, 204);
  await w.told();
  assert.equal(kc.endRequests.length, 1);
  assert.deepEqual(summary(await w.rows()), [['auth.login', 'success', A], ['auth.logout', 'logout', A]]);
  await w.finish('PC3');
});
