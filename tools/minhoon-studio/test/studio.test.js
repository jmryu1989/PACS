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
  assert.strictEqual(await call(mock, 'POST', '/api/admin/users'), null);
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
