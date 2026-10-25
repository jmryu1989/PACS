'use strict';
// Actual Nest GET, compiled reader and B2 writer on the owned migrated PG fixture.
const assert = require('node:assert/strict'), path = require('node:path');
const { randomUUID } = require('node:crypto');
require('reflect-metadata');
const { Module } = require('@nestjs/common'), { NestFactory } = require('@nestjs/core');
const { PrismaClient } = require('@prisma/client');
const build = process.env.KIN_ACCESS_REVIEW_BUILD;
const compiled = name => require(path.join(build, name));
const { AdminController } = compiled('admin.controller.js');
const { AdminAccessReview } = compiled('admin-access-review.js');
const { AdminService } = compiled('admin.service.js'), { PacsService } = compiled('pacs.service.js');
const { PrismaService } = compiled('prisma.service.js'), { StudyAccessService } = compiled('study-access.service.js');
const { createRecordPort } = compiled('emr-runtime/record-port.js');
const { createRequestContext, REQUEST_CONTEXT_SOURCE } = compiled('emr-runtime/request-context.js');
const { AccessLedgerStore } = compiled('emr-runtime/store.js');
const { FailureJournal, FailureSpool } = compiled('emr-runtime/failure-journal.js');
const known = value => ({ status: 'known', value });
const na = { status: 'not-applicable', reason: 'non-record-target' };
// The report's own real-time read must remain inside this fixture's period in future runs.
const now = new Date();
const day = offset => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset)).toISOString();
const from = day(-1), until = day(1);
function event(extra = {}) {
  return { formatVersion: 1, eventId: randomUUID(), surface: 'GET admin/users',
    userId: known({ id: 'SYN-ACTOR', issuer: 'SYN-ISSUER', subject: 'SYN-SUB' }), rolesAtTime: known(['admin']),
    actingInstitution: known('SYN-A'), managingInstitution: known('SYN-A'), occurredAt: from,
    trustedProxyIp: { status: 'unresolved', reason: 'not-observed' }, cause: 'user-view', executor: 'member',
    context: { basis: 'out-of-context', studyId: null, relatedStudyId: null, reason: null },
    targets: [{ kind: 'identity-access', patientLinkSnapshot: na, studyId: na, recordId: known('SYN-MEMBER'), versionId: na }],
    action: 'provide-prepared', result: 'prepared', requestId: randomUUID(), auditLinkId: `audit:${randomUUID()}`,
    relatedEventId: null, ...extra };
}
const target = kind => ({ kind, patientLinkSnapshot: known({ linkId: 'SYN-LINK', patientId: 'SYN-PATIENT', assigningAuthority: 'SYN-A' }),
  studyId: known('SYN-STUDY'), recordId: known('SYN-RECORD'), versionId: known('SYN-VERSION') });
(async () => {
  const db = new PrismaClient(), witness = new PrismaClient({ datasources: { db: { url: process.env.KIN_B2R_WITNESS_URL } } });
  const store = new AccessLedgerStore(db, new FailureJournal(db, new FailureSpool(process.env.KIN_B2R_SPOOL)));
  const requests = createRequestContext({ resolve: async () => ({ status: 'unresolved', reason: 'not-observed' }) }, createRecordPort(store).port);
  let app, changed = false;
  const access = { snapshot: async c => ({ policy: { restricted: c.sub === 'restricted' } }),
    unchanged: async () => { if (changed) { const { ForbiddenException } = require('@nestjs/common'); throw new ForbiddenException(); } } };
  try {
    await db.$connect(); await witness.$connect();
    const wanted = [];
    // One complete page plus a continuation exercises the product's existing 25-row page.
    for (let i = 0; i < 26; i++) { const e = event(); await store.append(e); wanted.push(e.eventId); }
    const dual = event({ surface: 'POST studies/:uid/report/commit', action: 'write', result: 'succeeded',
      targets: [target('report-version'), { ...target('report-version'), recordId: known('SYN-SECOND') }] });
    await store.append(dual); wanted.push(dual.eventId);
    const download = event({ surface: 'GET studies/:uid/original-downloads/:operationId/archive', targets: [target('download')] });
    await store.append(download); wanted.push(download.eventId);
    const aborted = event({ surface: download.surface, targets: download.targets, action: 'transfer-aborted', result: 'aborted', relatedEventId: download.eventId });
    await store.append(aborted); wanted.push(aborted.eventId);
    await store.append(event({ managingInstitution: known('SYN-B') }));
    await store.append(event({ occurredAt: until }));
    await store.append(event({ occurredAt: new Date(Date.parse(from) - 1).toISOString() }));
    class Fixture {}
    Module({ controllers: [AdminController], providers: [AdminAccessReview,
      { provide: PrismaService, useValue: db }, { provide: StudyAccessService, useValue: access },
      { provide: AdminService, useValue: { auditEvents: () => ({ legacy: true }),
        listUsers: () => ({ page: 1, pageSize: 25, total: 0, pendingCount: 0, users: [] }) } },
      { provide: PacsService, useValue: {} }, { provide: REQUEST_CONTEXT_SOURCE, useValue: requests.source }] })(Fixture);
    app = await NestFactory.create(Fixture, { logger: false });
    app.setGlobalPrefix('api');
    // Session acquisition is outside this reader test; exercise the controller's
    // real server-side admin, member, institution and study-policy decisions.
    app.use((req, res, next) => { Object.assign(req, { sub: req.headers['x-syn-sub'] || 'admin', actor: 'SYN-ADMIN',
      institution: req.headers['x-syn-inst'] === 'none' ? null : req.headers['x-syn-inst'] || 'SYN-A',
      roles: [req.headers['x-syn-role'] || 'admin'], kind: req.headers['x-syn-kind'] || 'member' });
      if (req.path === '/api/me') return res.json({ sub: req.sub, user: 'SYN Admin', roles: req.roles, institution: req.institution, sessionId: 'SYN-SESSION' });
      requests.capture.capture(req, res, { issuer: 'SYN-ISSUER', subject: req.sub, roles: req.roles,
        institution: req.institution, rightsVersion: 1, binding: { method: 'bearer', sessionRef: null } },
        { method: 'GET', route: 'admin/audit', purpose: 'clinical' }, async () => {});
      next(); });
    if (process.env.KIN_ACCESS_REVIEW_WEB) app.use('/worklist', require('express').static(process.env.KIN_ACCESS_REVIEW_WEB));
    await app.listen(process.env.KIN_ACCESS_REVIEW_READY ? 3000 : 0, process.env.KIN_ACCESS_REVIEW_READY ? '0.0.0.0' : '127.0.0.1');
    const base = (await app.getUrl()).replace('0.0.0.0','127.0.0.1');
    const query = { report: 'access', from, until, downloads: 'all' };
    const request = async (options = {}, headers = {}) => {
      const r = await fetch(`${base}/api/admin/audit?${new URLSearchParams({ ...query, ...options })}`, { headers });
      return { status: r.status, body: await r.json() };
    };
    let first = await request(); assert.equal(first.status, 200); assert.equal(first.body.rows.length, 25); assert.ok(first.body.next);
    const [self] = await witness.$queryRawUnsafe(`SELECT payload::jsonb AS event FROM emr_access.access_entry
      WHERE payload::jsonb->>'surface'='GET admin/audit' ORDER BY sequence DESC LIMIT 1`);
    assert.equal(self.event.action, 'provide-prepared');
    assert.equal(self.event.targets.length, first.body.rows.length);
    assert.ok(self.event.targets.every(t => t.kind === 'access-audit' && t.patientLinkSnapshot.status === 'not-applicable' && t.recordId.status === 'known'));
    const ids = self.event.targets.map(t => t.recordId.value);
    const served = await witness.$queryRawUnsafe(`SELECT event_id FROM emr_access.access_entry WHERE entry_id=ANY($1::uuid[])`, ids);
    assert.deepEqual(served.map(r => r.event_id).sort(), first.body.rows.map(r => r.eventId).sort());
    const after = first.body.next, later = event(); await store.append(later);
    const second = await request({ after }); assert.equal(second.status, 200); assert.equal(second.body.next, null);
    const all = [...first.body.rows, ...second.body.rows];
    assert.deepEqual(all.map(r => r.eventId).sort(), wanted.sort());
    assert.equal(all.filter(r => r.eventId === dual.eventId).length, 1);
    assert.equal(all.find(r => r.eventId === dual.eventId).targets.length, 2);
    assert.equal(all.find(r => r.eventId === download.eventId).result, 'prepared');
    assert.deepEqual(all[0].trustedProxyIp, { status: 'unresolved', reason: 'not-observed' });
    const files = await request({ downloads: 'files' });
    assert.deepEqual(files.body.rows.map(r => [r.eventId, r.result]), [[aborted.eventId, 'aborted'], [download.eventId, 'prepared']]);
    const again = await request(); assert.ok(again.body.rows.some(r => r.eventId === self.event.eventId));
    const empty = await request({ from: day(2), until: day(3) });
    assert.deepEqual(empty.body.rows, []); assert.equal(empty.body.next, null);
    for (const headers of [{ 'x-syn-role': 'radiologist' }, { 'x-syn-inst': 'none' }, { 'x-syn-kind': 'gateway' }, { 'x-syn-sub': 'restricted' }])
      assert.equal((await request({}, headers)).status, 403);
    assert.equal((await request({ after, downloads: 'files' })).status, 400);
    assert.equal((await request({ from: until, until: from })).status, 400);
    assert.equal((await request({}, { 'x-syn-inst': 'SYN-B' })).body.rows.length, 1);
    changed = true; assert.equal((await request()).status, 403); changed = false;
    const legacy = await fetch(`${base}/api/admin/audit`); assert.deepEqual(await legacy.json(), { legacy: true });
    await witness.$executeRawUnsafe('ALTER TABLE emr_access.access_entry RENAME TO access_entry_unavailable');
    try { const failed = await request(); assert.equal(failed.status, 503); assert.equal(failed.body.rows, undefined); }
    finally { await witness.$executeRawUnsafe('ALTER TABLE emr_access.access_entry_unavailable RENAME TO access_entry'); }
    await witness.$executeRawUnsafe('REVOKE EXECUTE ON FUNCTION emr_access.admit_operation(uuid,uuid,text,text) FROM kin_runtime');
    try { const refused = await request(); assert.equal(refused.status, 503); assert.equal(refused.body.rows, undefined); }
    finally { await witness.$executeRawUnsafe('GRANT EXECUTE ON FUNCTION emr_access.admit_operation(uuid,uuid,text,text) TO kin_runtime'); }
    if (process.env.KIN_ACCESS_REVIEW_READY) {
      const fs = require('node:fs'), ready = process.env.KIN_ACCESS_REVIEW_READY;
      fs.writeFileSync(ready, JSON.stringify({ from, until, selfEventId: self.event.eventId, downloadEventId: download.eventId }));
      while (!fs.existsSync(ready + '.done')) await new Promise(resolve => setTimeout(resolve, 100));
    }
    console.log('PASS: migrated PG + B2 writer + real Nest Admin GET: period, recorded institution, dedup, targets, pages, file stages, empty, refusals and read failure');
  } finally { if (app) await app.close(); await db.$disconnect(); await witness.$disconnect(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
