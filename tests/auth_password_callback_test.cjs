'use strict';
// The Change Password tab reports Keycloak's outcome and never creates or replaces the product session. The compiled
// controller/service run unmodified; only the session/rights DB reads are synthetic and no network is used.
// Keycloak's error answer carries state but no code (OIDC error response), so that shape is covered beside success/cancel.
const { test } = require('node:test');
const assert = require('node:assert/strict');
Object.assign(process.env, { PUBLIC_ORIGIN: 'https://synthetic.invalid', KC_ISSUER: 'https://synthetic.invalid/auth/realms/kin',
  KIN_COOKIE_SECRET: 'synthetic-cookie-secret-for-the-password-callback-test-only' });
delete process.env.KC_JWKS_URL;
const { AuthService } = require('/app/dist/auth.service');
const { PresenceService } = require('/app/dist/presence.service');
const { AuthController } = require('/app/dist/auth.controller');

const db = { authSession: { findUnique: async () => ({ sub: 'synthetic-user', lastSeenAt: new Date(), rightsVersion: 0 }) },
  memberRightsImport: { findUnique: async () => ({ id: 'realm-v1' }) },
  memberRights: { findUnique: async () => ({ suspended: false, version: 0 }) } };
const unused = new Proxy({}, { get() { throw new Error('unexpected external dependency'); } });
function response() {
  return { headers: {}, getHeader(n) { return this.headers[n]; }, setHeader(n, v) { this.headers[n] = v; },
    append(n, v) { this.headers[n] = [...(this.headers[n] || []), v]; return this; }, status(n) { this.statusCode = n; return this; },
    type(t) { this.mime = t; return this; }, set(n, v) { this.headers[n] = v; return this; }, send(body) { this.body = body; return this; },
    redirect(code, url) { this.statusCode = code; this.location = url; return this; } };
}
const cookies = res => [res.headers['Set-Cookie'] ?? []].flat();
const NOTICE = { success: '비밀번호를 변경했습니다', cancelled: '비밀번호 변경을 취소했습니다', error: '비밀번호 변경을 마치지 못했습니다' };

async function passwordCallback({ code, error, status }) {
  const service = new AuthService(db, unused, unused, unused, new PresenceService(db, null)), controller = new AuthController(service);
  const req = { headers: { cookie: 'kin_sid=synthetic-session' } }, start = response();
  const url = new URL(await service.beginLogin(req, start, undefined, 'UPDATE_PASSWORD'));
  const pending = cookies(start).map(v => v.split(';')[0]);
  assert.equal(pending.length, 1);
  req.headers.cookie += '; ' + pending.join('; ');
  const res = response();
  await controller.callback(req, res, code, url.searchParams.get('state'), error, status);
  return { res, pendingName: pending[0].split('=')[0] };
}

for (const [name, query, outcome] of [
  ['success', { code: 'synthetic-code', status: 'success' }, 'success'],
  ['cancelled', { code: 'synthetic-code', status: 'cancelled' }, 'cancelled'],
  ['unknown status', { code: 'synthetic-code', status: 'unknown' }, 'error'],
  ['provider error without code', { error: 'access_denied' }, 'error'],
  ['provider error with a success status', { error: 'access_denied', status: 'success' }, 'error'],
]) {
  test(`password callback, ${name}: the fixed notice, this flow consumed, no session written`, async () => {
    const { res, pendingName } = await passwordCallback(query);
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes(NOTICE[outcome]), res.body);
    const written = cookies(res);
    assert.ok(written.some(v => v.startsWith(pendingName + '=')), 'the password flow cookie is expired');
    assert.ok(!written.some(v => v.startsWith('kin_sid=')), 'no product session cookie');
  });
}

test('an ordinary callback without code or state while signed in still returns to the worklist', async () => {
  const controller = new AuthController(new AuthService(db, unused, unused, unused, new PresenceService(db, null))), res = response();
  await controller.callback({ headers: { cookie: 'kin_sid=synthetic-session' } }, res, undefined, undefined, 'access_denied', undefined);
  assert.deepEqual([res.statusCode, res.location], [302, 'https://synthetic.invalid/worklist/hpacs-lite/main.html']);
});
