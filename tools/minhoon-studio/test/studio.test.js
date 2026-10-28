'use strict';
// Studio unit tests (run command in the README, "Laptop development").
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { maskSecrets, safeJoin } = require('../server/util');
const { hashPassword, verifyPassword, Auth } = require('../server/auth');
const { Mock } = require('../server/mock');
const { allowed } = require('../server/sandbox');
const { splitRecords, visiblePart } = require('../server/chat');
const { inlineScripts, syntaxError } = require('../server/build');
const crypto = require('crypto');

const SEED = path.join(__dirname, '../sandbox-seed');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mstudio-'));

test('live secrets are masked, ordinary text is kept', () => {
  const text = 'key sk-ant-api03-abcdefghijklmnop and password: hunter2hunter2 and eyJhbGciOiJI.eyJzdWIiOiIxMjM0.c2lnbmF0dXJlc2ln ok';
  const out = maskSecrets(text);
  assert.ok(!out.includes('sk-ant-api03'));
  assert.ok(!out.includes('hunter2hunter2'));
  assert.ok(!out.includes('eyJhbGciOiJI'));
  assert.ok(out.includes('password: [비밀값 제외]'));
  assert.strictEqual(maskSecrets('Findings 입력칸을 두 배로 키웠어요 (main.html:297)'), 'Findings 입력칸을 두 배로 키웠어요 (main.html:297)');
  assert.ok(maskSecrets('-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----').indexOf('abc') < 0);
});

test('paths cannot escape the served root', () => {
  const root = path.resolve('/srv/x');
  assert.strictEqual(safeJoin(root, '../etc/passwd'), path.join(root, 'etc/passwd'));
  assert.strictEqual(safeJoin(root, '%2e%2e/%2e%2e/etc/passwd'), path.join(root, 'etc/passwd'));
  assert.strictEqual(safeJoin(root, 'a\0b'), null);
});

test('password hashes verify only the right password; mistypes never lock the right password out', () => {
  const record = hashPassword('correct horse battery');
  assert.ok(verifyPassword('correct horse battery', record));
  assert.ok(!verifyPassword('wrong', record));
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify({ minhoon: { displayName: '민훈', ...record } }));
  const auth = new Auth(dir);
  for (let i = 0; i < 20; i++) assert.strictEqual(auth.login('minhoon', 'x').error, 'invalid');
  assert.ok(auth.login('minhoon', 'correct horse battery').sid);
  assert.strictEqual(auth.login('nobody', 'x').error, 'invalid');
});

test('chat edits may only land in front-end and studio-mock paths', () => {
  assert.ok(allowed('worklist-v0/hpacs-lite/main.html'));
  assert.ok(allowed('config/ohif/layout.js'));
  assert.ok(allowed('config/ohif.js'));
  assert.ok(allowed('studio-mock/routes.json'));
  for (const f of ['api/src/pacs.controller.ts', 'scripts/build-main-split-bundle.py', 'tests/x.py', 'AGENTS.md', 'config/orthanc.json', 'worklist-v0/other/x.js']) assert.ok(!allowed(f), f);
});

test('record blocks are taken out of the visible answer and parsed', () => {
  const { text, records } = splitRecords('잠깐요 — 이유.\n<studio-record>{"kind":"disagreement","trigger":"A"}</studio-record>\n<studio-record>not json</studio-record>');
  assert.strictEqual(text, '잠깐요 — 이유.');
  assert.deepStrictEqual(records[0], { kind: 'disagreement', trigger: 'A' });
  assert.strictEqual(records[1].kind, 'unparsed');
  assert.strictEqual(visiblePart('답입니다 <studio-rec'), '답입니다 ');
  assert.strictEqual(visiblePart('답 <studio-record>{"kind":'), '답 ');
});

test('build check finds a syntax error in an inline script and passes valid code', () => {
  const blocks = inlineScripts('<script src="a.js"></script><script>let a = ;</script><script type="application/json">{}</script>');
  assert.strictEqual(blocks.length, 1);
  assert.ok(syntaxError(blocks[0].code, 'x'));
  assert.strictEqual(syntaxError('const ok = 1;', 'y'), null);
});

function mockFor() {
  const dir = tmp();
  return new Mock({ dataDir: dir, sandboxDir: SEED, dicomweb: null });
}

async function call(mock, method, url, body) {
  const u = new URL(url, 'http://studio.test');
  const out = mock.route(method, u.pathname, u.searchParams, body || {}, mock.me('minhoon', '민훈', 'http://studio.test'), { user: 'minhoon', origin: 'http://studio.test' });
  return out;
}

test('mock answers unknown routes with nothing (the server turns that into 501), never a catch-all 200', async () => {
  const mock = mockFor();
  assert.strictEqual(await call(mock, 'GET', '/api/does-not-exist'), null);
  assert.strictEqual(await call(mock, 'DELETE', '/api/admin/users/studio-kim-jiho'), null);
});

function adminCall(mock, method, url, body) {
  mock.setRole('minhoon', 'admin');
  return call(mock, method, url, body);
}

test('admin members: approve needs a verified email or the in-person box, a stale version is refused, self rules hold', async () => {
  const mock = mockFor();
  const list = (await adminCall(mock, 'GET', '/api/admin/users?page=1')).body;
  assert.strictEqual(list.pageSize, 25);
  assert.ok(list.users.every(u => ['APPROVED', 'PENDING'].includes(u.approvalState)));
  assert.strictEqual(list.pendingCount, list.users.filter(u => u.approvalState === 'PENDING').length);
  const unverified = list.users.find(u => u.approvalState === 'PENDING' && !u.emailVerified);
  const approve = { approvalState: 'APPROVED', institution: 'kin-center', roles: ['radiologist'], version: unverified.version };
  assert.strictEqual((await adminCall(mock, 'PATCH', `/api/admin/users/${unverified.id}`, approve)).status, 400);
  const done = await adminCall(mock, 'PATCH', `/api/admin/users/${unverified.id}`, { ...approve, verificationOverride: true });
  assert.strictEqual(done.status, 200);
  assert.strictEqual(done.body.approvalState, 'APPROVED');
  const stale = await adminCall(mock, 'PATCH', `/api/admin/users/${unverified.id}`, { enabled: false, version: done.body.version - 1 });
  assert.strictEqual(stale.status, 409); assert.strictEqual(stale.body.code, 'MEMBER_VERSION_CONFLICT');
  const self = list.users.find(u => u.id === 'studio-minhoon');
  assert.strictEqual((await adminCall(mock, 'PATCH', '/api/admin/users/studio-minhoon', { enabled: false, version: self.version })).status, 400);
  const created = await adminCall(mock, 'POST', '/api/admin/users', { username: 'synthetic.new', email: 'synthetic.new@studio.invalid', firstName: 'A', lastName: 'B' });
  assert.strictEqual(created.status, 200); assert.ok(created.body.temporaryPassword); assert.strictEqual(created.body.approvalState, 'PENDING');
  assert.strictEqual((await adminCall(mock, 'POST', `/api/admin/users/${created.body.id}/reset-password`, { mode: 'email' })).status, 501);
  // Each change is in the audit list, newest first, with the member snapshot fields only (no email).
  const audit = (await adminCall(mock, 'GET', '/api/admin/audit?limit=2')).body;
  assert.strictEqual(audit.rows.length, 2); assert.ok(audit.next);
  assert.ok(audit.rows.every(r => r.rule !== 'member_snapshots' || !('email' in (r.detail.after || {}))));
  const more = (await adminCall(mock, 'GET', `/api/admin/audit?limit=2&after=${encodeURIComponent(audit.next)}`)).body;
  assert.notDeepStrictEqual(more.rows, audit.rows);
  mock.setRole('minhoon', 'radiologist');
  assert.strictEqual((await call(mock, 'GET', '/api/admin/users')).status, 403);
});

test('admin signing key and study access follow expected-kid and revision rules', async () => {
  const mock = mockFor();
  const id = 'studio-han-tech';
  const view = (await adminCall(mock, 'GET', `/api/admin/users/${id}/signing-key`)).body;
  assert.strictEqual(view.current, null);
  const made = await adminCall(mock, 'POST', `/api/admin/users/${id}/signing-key`, { action: 'provision', expectedKid: null, reason: 'synthetic' });
  assert.strictEqual(made.status, 200); assert.ok(made.body.current);
  const wrong = await adminCall(mock, 'POST', `/api/admin/users/${id}/signing-key`, { action: 'replace', expectedKid: '00000000-0000-4000-8000-000000000000', reason: 'x' });
  assert.strictEqual(wrong.status, 409);
  const rotated = (await adminCall(mock, 'POST', `/api/admin/users/${id}/signing-key`, { action: 'replace', expectedKid: made.body.current, reason: 'x' })).body;
  assert.notStrictEqual(rotated.current, made.body.current);
  assert.strictEqual(rotated.keys.find(k => k.kid === made.body.current).status, 'revoked');
  const access = (await adminCall(mock, 'GET', `/api/admin/users/${id}/study-access`)).body;
  assert.deepStrictEqual(access.owner, ['kin-center', 'studio-minhoon']);
  const policy = { version: 1, restricted: true, startsAt: null, endsAt: null, rules: [{ patientId: null, modalities: ['CT'], dateFrom: null, dateTo: null, studyUids: [] }] };
  const save = { expectedOwner: access.owner, revision: access.revision, policy, reason: 'synthetic', requestId: crypto.randomUUID() };
  const saved = await adminCall(mock, 'POST', `/api/admin/users/${id}/study-access`, save);
  assert.strictEqual(saved.body.revision, access.revision + 1);
  assert.strictEqual((await adminCall(mock, 'POST', `/api/admin/users/${id}/study-access`, save)).body.replayed, true);
  assert.strictEqual((await adminCall(mock, 'POST', `/api/admin/users/${id}/study-access`, { ...save, requestId: crypto.randomUUID() })).status, 409);
  const events = (await adminCall(mock, 'GET', `/api/admin/audit?report=access&from=${encodeURIComponent(new Date(Date.now() - 3600e3).toISOString())}&until=${encodeURIComponent(new Date(Date.now() + 60e3).toISOString())}&downloads=all`)).body;
  assert.ok(events.rows.some(e => e.surface === 'POST admin/users/:id/study-access'));
});

// The rules of api/src/study-access-policy.ts normalizeAccessPolicy and study-access.service.ts write(), as the
// admin form sends them: what the product refuses is refused, and nothing is stored.
test('admin study access refuses what the product refuses: reversed dates, a mistyped UID, a modality twice', async () => {
  const mock = mockFor();
  const id = 'studio-han-tech';
  const url = `/api/admin/users/${id}/study-access`;
  const before = (await adminCall(mock, 'GET', url)).body;
  const rule = extra => ({ patientId: null, modalities: [], dateFrom: null, dateTo: null, studyUids: [], ...extra });
  const send = (rules, extra = {}) => adminCall(mock, 'POST', url, { expectedOwner: before.owner, revision: before.revision, reason: '외부 판독 계약',
    requestId: crypto.randomUUID(), policy: { version: 1, restricted: true, startsAt: null, endsAt: null, rules }, ...extra });
  for (const [what, rules] of [['reversed dates', [rule({ dateFrom: '2026-10-28', dateTo: '2026-10-01' })]],
    ['a mistyped UID', [rule({ studyUids: ['1.2..3'] })]], ['CT twice', [rule({ modalities: ['CT', 'CT'] })]],
    ['a lower-case modality', [rule({ modalities: ['ct'] })]], ['a date that does not exist', [rule({ dateFrom: '2026-02-30' })]],
    ['an empty rule', [rule({})]], ['the same rule twice', [rule({ modalities: ['CT'] }), rule({ modalities: ['CT'] })]],
    ['all studies next to another rule', [{ all: true }, rule({ modalities: ['CT'] })]]]) {
    const out = await send(rules);
    assert.strictEqual(out.status, 400, what);
    assert.strictEqual(out.body.message, '검사 접근 조건 형식을 확인하세요', what);
  }
  const timed = (startsAt, endsAt) => adminCall(mock, 'POST', url, { expectedOwner: before.owner, revision: before.revision, reason: 'x', requestId: crypto.randomUUID(),
    policy: { version: 1, restricted: true, startsAt, endsAt, rules: [{ all: true }] } });
  assert.strictEqual((await timed('2026-10-28T00:00:00.000Z', '2026-10-01T00:00:00.000Z')).status, 400);
  assert.strictEqual((await send([rule({ modalities: ['CT'] })], { reason: '   ' })).status, 400);
  assert.strictEqual((await send([rule({ modalities: ['CT'] })], { requestId: 'r-1' })).status, 400);
  assert.deepStrictEqual((await adminCall(mock, 'GET', url)).body, before);
  // A valid rule is stored the way the product stores it: modalities and UIDs sorted, the patient id trimmed.
  const ok = await send([rule({ patientId: ' P-1 ', modalities: ['MR', 'CT'], studyUids: ['1.2.3', '1.2.10'], dateFrom: '2026-10-01', dateTo: '2026-10-28' })]);
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual((await adminCall(mock, 'GET', url)).body.policy.rules,
    [{ patientId: 'P-1', modalities: ['CT', 'MR'], dateFrom: '2026-10-01', dateTo: '2026-10-28', studyUids: ['1.2.10', '1.2.3'] }]);
});

// admin.service.ts auditEvents and admin-access-review.ts: the first page fixes the newest record, the next page
// continues below the last one served. A change made between the pages neither repeats a row nor moves the total.
test('admin Audit and Access Review Load More never repeat a record after a change in between', async () => {
  const mock = mockFor();
  const id = 'studio-han-tech';
  const url = `/api/admin/users/${id}/study-access`;
  const owner = (await adminCall(mock, 'GET', url)).body.owner;
  let revision = (await adminCall(mock, 'GET', url)).body.revision;
  const change = async () => {
    const out = await adminCall(mock, 'POST', url, { expectedOwner: owner, revision, reason: `change ${revision}`, requestId: crypto.randomUUID(),
      policy: revision % 2 ? { version: 1, restricted: false, startsAt: null, endsAt: null, rules: [] } : { version: 1, restricted: true, startsAt: null, endsAt: null, rules: [{ all: true }] } });
    assert.strictEqual(out.status, 200);
    revision = out.body.revision;
  };
  for (let i = 0; i < 30; i++) await change();
  const key = row => JSON.stringify(row);

  const first = (await adminCall(mock, 'GET', '/api/admin/audit?limit=5')).body;
  const everything = (await adminCall(mock, 'GET', '/api/admin/audit?limit=100')).body.rows.map(key);
  await change();
  const second = (await adminCall(mock, 'GET', `/api/admin/audit?limit=5&after=${encodeURIComponent(first.next)}`)).body;
  assert.strictEqual(second.total, first.total);
  assert.deepStrictEqual([...first.rows, ...second.rows].map(key), everything.slice(0, 10));
  assert.strictEqual(new Set([...first.rows, ...second.rows].map(key)).size, 10);

  const range = `report=access&from=${encodeURIComponent(new Date(Date.now() - 86400e3).toISOString())}&until=${encodeURIComponent(new Date(Date.now() + 3600e3).toISOString())}&downloads=all`;
  const page1 = (await adminCall(mock, 'GET', `/api/admin/audit?${range}`)).body;
  assert.strictEqual(page1.rows.length, 25); assert.ok(page1.next);
  await change();
  const page2 = (await adminCall(mock, 'GET', `/api/admin/audit?${range}&after=${encodeURIComponent(page1.next)}`)).body;
  const ids = [...page1.rows, ...page2.rows].map(e => e.eventId);
  assert.strictEqual(new Set(ids).size, ids.length);
  assert.ok(page2.rows.length > 0);
  // Newest first in record order: the event made between the pages is on neither page.
  const newest = (await adminCall(mock, 'GET', `/api/admin/audit?${range}`)).body.rows[0];
  assert.ok(!ids.includes(newest.eventId));
  assert.ok(page1.rows.every((e, i, all) => i === 0 || e.recordedAt <= all[i - 1].recordedAt));
});

test('admin gateway receipts are own-study only and Now Retry answers only a retry receipt, once', async () => {
  const mock = mockFor();
  const list = (await adminCall(mock, 'GET', '/api/studies')).body;
  const withReceipt = list.studies.filter(s => s.gatewayReceipt);
  assert.ok(withReceipt.length >= 2);
  assert.ok(withReceipt.every(s => !s.tele));
  const retry = withReceipt.find(s => s.gatewayReceipt.phase === 'retry');
  const first = await adminCall(mock, 'POST', `/api/studies/${retry.uid}/gateway-retry`, {});
  assert.strictEqual(first.body.result, 'requested');
  assert.strictEqual((await adminCall(mock, 'POST', `/api/studies/${retry.uid}/gateway-retry`, {})).body.result, 'already_requested');
  const other = withReceipt.find(s => s.gatewayReceipt.phase !== 'retry');
  assert.strictEqual((await adminCall(mock, 'POST', `/api/studies/${other.uid}/gateway-retry`, {})).status, 409);
  const metrics = (await adminCall(mock, 'GET', '/api/admin/metrics')).body;
  assert.strictEqual(new Set(metrics.metrics.map(r => r.key)).size, 11);
});

test('worklist page follows the client contract: owner, limit, ascending uids, total', async () => {
  const mock = mockFor();
  const out = (await call(mock, 'GET', '/api/studies?limit=100')).body;
  assert.deepStrictEqual(out.pagination.owner, ['kin-center', 'studio-minhoon']);
  assert.strictEqual(out.pagination.limit, 100);
  assert.strictEqual(out.pagination.total, out.studies.length);
  const uids = out.studies.map(s => s.uid);
  assert.deepStrictEqual(uids, [...uids].sort());
  for (const row of out.studies) assert.match(row.state.draftRevision, /^[^:\s]+:\d+$/);
});

test('draft autosave and commit move the revision one step at a time and refuse a stale revision', async () => {
  const mock = mockFor();
  const uid = '2.25.202610270001';
  const me = mock.me('minhoon', '민훈', 'http://studio.test');
  const owner = { institution: me.institution, sub: me.sub, author: me.actor };
  const draft = (await call(mock, 'GET', `/api/studies/${uid}/draft`)).body;
  assert.strictEqual(draft.present, false);
  const put = await call(mock, 'PUT', `/api/studies/${uid}/report`, { expectedOwner: owner, expectedRevision: draft.revision,
    findings: 'f', conclusion: 'c', recommendation: '', baseVersion: 0, citationIds: [], structureIds: [] });
  assert.strictEqual(put.status, 200);
  assert.strictEqual(put.body.revision, draft.revision.replace(/:0$/, ':1'));
  const stale = await call(mock, 'PUT', `/api/studies/${uid}/report`, { expectedOwner: owner, expectedRevision: draft.revision,
    findings: 'g', conclusion: 'c', recommendation: '', baseVersion: 0, citationIds: [], structureIds: [] });
  assert.strictEqual(stale.status, 409);
  assert.strictEqual(stale.body.code, 'REPORT_DRAFT_CONFLICT');
  const save = await call(mock, 'POST', `/api/studies/${uid}/report/commit`, { action: 'save', baseVersion: 0, findings: 'f', conclusion: 'c', recommendation: '',
    expectedOwner: owner, expectedRevision: put.body.revision });
  assert.strictEqual(save.status, 200);
  assert.strictEqual(save.body.state.rs, 'T');
  assert.strictEqual(save.body.state.draftRevision, save.body.revision);
  const approve = await call(mock, 'POST', `/api/studies/${uid}/report/commit`, { action: 'approve', baseVersion: 1, findings: 'f', conclusion: 'c', recommendation: '',
    expectedOwner: owner, expectedRevision: save.body.revision });
  assert.strictEqual(approve.body.state.rs, 'A');
  const again = await call(mock, 'POST', `/api/studies/${uid}/report/commit`, { action: 'save', baseVersion: 2, findings: 'x', conclusion: 'c', recommendation: '',
    expectedOwner: owner, expectedRevision: approve.body.revision });
  assert.strictEqual(again.status, 400, 'an approved report only changes through Addendum or Reset');
  const versions = (await call(mock, 'GET', `/api/studies/${uid}/report/versions`)).body;
  assert.deepStrictEqual(versions.map(v => v.action), ['approve', 'save']);
  const reset = await call(mock, 'POST', `/api/studies/${uid}/report/commit`, { action: 'reset', baseVersion: 2, findings: '', conclusion: '', recommendation: '',
    expectedOwner: owner, expectedRevision: approve.body.revision });
  assert.strictEqual(reset.status, 400, 'reset needs a reason');
});

test('a study another reader holds refuses writes with REPORT_HELD; Unverified refuses commits', async () => {
  const mock = mockFor();
  const me = mock.me('minhoon', '민훈', 'http://studio.test');
  const owner = { institution: me.institution, sub: me.sub, author: me.actor };
  const held = '2.25.202610270016';
  const d = (await call(mock, 'GET', `/api/studies/${held}/draft`)).body;
  const r = await call(mock, 'POST', `/api/studies/${held}/report/commit`, { action: 'save', baseVersion: 0, findings: 'f', conclusion: '', recommendation: '', expectedOwner: owner, expectedRevision: d.revision });
  assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'REPORT_HELD');
  const unv = '2.25.202610270014';
  const d2 = (await call(mock, 'GET', `/api/studies/${unv}/draft`)).body;
  const r2 = await call(mock, 'POST', `/api/studies/${unv}/report/commit`, { action: 'approve', baseVersion: 0, findings: 'f', conclusion: '', recommendation: '', expectedOwner: owner, expectedRevision: d2.revision });
  assert.strictEqual(r2.status, 409);
});

test('clinical context answers the closed shape: prior reports only from approved heads of the same patient', async () => {
  const mock = mockFor();
  const cc = (await call(mock, 'GET', '/api/studies/2.25.202610270001/clinical-context')).body;
  assert.deepStrictEqual(Object.keys(cc).sort(), ['anchor', 'identity', 'observedAt', 'patientKey', 'schema', 'sections', 'uid']);
  assert.strictEqual(cc.sections.priorReports.state, 'present');
  assert.strictEqual(cc.sections.priorReports.items[0].studyUid, '2.25.202610270002');
  assert.strictEqual(cc.sections.priorReports.items[0].report.action, 'approve');
  assert.match(cc.observedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('prototype routes from studio-mock/routes.json win over the built-in mock', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'studio-mock'));
  fs.copyFileSync(path.join(SEED, 'studio-mock/dataset.json'), path.join(dir, 'studio-mock/dataset.json'));
  fs.writeFileSync(path.join(dir, 'studio-mock/routes.json'), JSON.stringify({ routes: [{ method: 'GET', path: '/api/studies/:uid/preload', body: { uid: ':uid', state: 'Queued' } }] }));
  const mock = new Mock({ dataDir: tmp(), sandboxDir: dir, dicomweb: null });
  const hit = mock.customRoute('GET', '/api/studies/2.25.1/preload');
  assert.ok(hit);
  assert.strictEqual(hit.params.uid, '2.25.1');
  assert.strictEqual(mock.customRoute('POST', '/api/studies/2.25.1/preload'), null);
});
