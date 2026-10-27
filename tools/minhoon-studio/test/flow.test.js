'use strict';
// Studio flow tests on real git sandboxes and data folders: failed Claude turns, undo, the read snapshot, digests and
// the synthetic identity in image metadata. The Claude CLI itself is replaced by a stub that returns its result shape.
// Run command in the README ("Laptop development").
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Sandbox, ALLOWED } = require('../server/sandbox');
const { Chat } = require('../server/chat');
const { StatusFeed } = require('../server/status');
const { writeDigest, listDigests, DIGEST_ID } = require('../server/digest');
const { buildAndCheck } = require('../server/build');
const { DicomWeb } = require('../server/dicomweb');
const { Mock } = require('../server/mock');
const { readJsonl, appendJsonl } = require('../server/util');

const SEED = path.join(__dirname, '../sandbox-seed');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mstudio-flow-'));
const PAGE = 'worklist-v0/hpacs-lite/main.html';
// No bundled sources, so the build check runs only the syntax checks (the product builders are not in these repos).
const ORDER = JSON.stringify({ page: PAGE, sources: [], artifact: 'worklist-v0/hpacs-lite/main-split.bundle.js' });

function repo(files = {}) {
  const dir = tmp();
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir });
  git('init', '-q');
  git('config', 'core.autocrlf', 'false'); // a Windows checkout would otherwise rewrite the line endings compared below
  for (const [file, text] of Object.entries({ [PAGE]: '<p>v0</p>\n', ...files })) write(dir, file, text);
  git('add', '-A'); git('commit', '-q', '-m', 'base'); git('tag', 'studio-base');
  return dir;
}

function write(dir, file, text) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
}
const read = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf8');

async function change(sandbox, file, text, subject) {
  write(sandbox.dir, file, text);
  return sandbox.commit({ subject, trailers: { 'Studio-Kind': 'change', 'Studio-User': 'minhoon' } });
}

function chatFor(sandbox, statusDir = tmp()) {
  const data = tmp();
  const chat = new Chat({ config: { claude: { python: 'python', shellTool: 'Bash', account: 'a', configDirs: { a: data } } },
    sandbox, dataDir: data, broadcast: () => {}, statusFeed: new StatusFeed(statusDir) });
  return { chat, data };
}

const cliResult = extra => ({ text: '', model: 'stub', tools: [], edits: [], denials: [], t: { spawn: Date.now(), done: Date.now() }, ...extra });
const idle = async chat => { await chat.queue; while (chat.activeJobIds().length) await new Promise(r => setTimeout(r, 5)); };

test('a timed-out edit turn that left a parsable half edit is recorded as failed and never published', async () => {
  const sandbox = new Sandbox({ dir: repo() });
  await sandbox.check();
  const { chat, data } = chatFor(sandbox);
  chat.claude = async () => { write(sandbox.dir, PAGE, '<p>half</p>\n'); return cliResult({ text: '반쯤 고쳤', timedOut: true, exitCode: null }); };
  chat.enqueue({ user: 'minhoon', displayName: '민훈', mode: 'edit', text: 'Findings 칸을 키워 주세요' });
  await idle(chat);
  assert.strictEqual(read(sandbox.dir, PAGE), '<p>v0</p>\n');
  assert.deepStrictEqual(await sandbox.log(), []);
  const answer = chat.history().pop();
  assert.strictEqual(answer.meta.failed, true);
  assert.strictEqual(answer.meta.reason, 'claude-timeout');
  const metric = readJsonl(path.join(data, 'metrics.jsonl')).pop();
  assert.strictEqual(metric.ok, false);
  const digest = await writeDigest({ dataDir: data, sandbox, activeJobs: () => chat.activeJobIds() });
  assert.strictEqual(digest.summary.requests[0].outcome, 'failed');
  assert.strictEqual(digest.summary.counts.applied, 0);
});

test('an error result or a non-zero exit is a failed turn in both modes', async () => {
  const sandbox = new Sandbox({ dir: repo() });
  await sandbox.check();
  const { chat, data } = chatFor(sandbox);
  chat.claude = async () => { write(sandbox.dir, PAGE, '<p>edited</p>\n'); return cliResult({ sawResult: true, isError: true, exitCode: 1, text: 'API Error: overloaded', subtype: 'error_during_execution' }); };
  chat.enqueue({ user: 'minhoon', displayName: '민훈', mode: 'edit', text: '버튼 색' });
  await idle(chat);
  assert.strictEqual(read(sandbox.dir, PAGE), '<p>v0</p>\n');
  chat.claude = async () => cliResult({ exitCode: -4058 });
  chat.enqueue({ user: 'minhoon', displayName: '민훈', mode: 'ask', text: 'PF 열은 무슨 뜻?' });
  await idle(chat);
  const digest = await writeDigest({ dataDir: data, sandbox, activeJobs: () => chat.activeJobIds() });
  assert.deepStrictEqual(digest.summary.requests.map(r => r.outcome), ['failed', 'failed']);
  assert.ok(!readJsonl(path.join(data, 'metrics.jsonl')).some(m => m.ok));
});

test('an edit turn reads the same status summary a question does (critique trigger C)', async () => {
  const statusDir = tmp();
  fs.writeFileSync(path.join(statusDir, 'status.json'), JSON.stringify({ published_at: new Date().toISOString(), decisions: [{ id: 'SYNTH-DECISION-7', text: 'Related Report stays open by default' }] }));
  const sandbox = new Sandbox({ dir: repo() });
  await sandbox.check();
  const { chat } = chatFor(sandbox, statusDir);
  const prompts = [];
  chat.claude = async (job, mode, prompt) => { prompts.push(prompt); return cliResult({ sawResult: true, exitCode: 0, text: '바꾸지 않았습니다.' }); };
  chat.enqueue({ user: 'minhoon', displayName: '민훈', mode: 'edit', text: 'Related Report를 기본으로 접어 주세요' });
  await idle(chat);
  assert.match(prompts[0], /SYNTH-DECISION-7/);
});

test('an older change is undone only together with the later changes built on it, and the result is checked', async () => {
  const sandbox = new Sandbox({ dir: repo({ 'scripts/main-split-order.json': ORDER }) });
  await sandbox.check();
  const validate = files => buildAndCheck(sandbox.dir, files, { python: 'python' });
  const a = await change(sandbox, 'worklist-v0/hpacs-lite/helper.js', 'function helper() { return 1; }\n', 'A helper');
  const b = await change(sandbox, PAGE, '<p>v1</p><script src="helper.js"></script><script>helper();</script>\n', 'B uses helper');
  const head = await sandbox.head();

  const alone = await sandbox.revert({ sha: a.sha, user: 'minhoon', validate });
  assert.strictEqual(alone.code, 'later-changes');
  assert.deepStrictEqual(alone.later.map(c => c.sha), [b.sha]);
  assert.strictEqual(await sandbox.head(), head, 'nothing is published without confirmation');
  assert.ok(fs.existsSync(path.join(sandbox.dir, 'worklist-v0/hpacs-lite/helper.js')));

  const both = await sandbox.revert({ sha: a.sha, user: 'minhoon', withLater: true, validate });
  assert.deepStrictEqual(both.undone.map(c => c.sha), [b.sha, a.sha]);
  assert.strictEqual(read(sandbox.dir, PAGE), '<p>v0</p>\n');
  assert.ok(!fs.existsSync(path.join(sandbox.dir, 'worklist-v0/hpacs-lite/helper.js')));
  assert.deepStrictEqual((await sandbox.log()).filter(c => c.trailers['Studio-Kind'] === 'change' && !c.reverted), []);
});

test('an undo whose result fails the build check keeps the version on screen', async () => {
  // The base page carries a broken inline script; change C fixed it, so undoing C would publish the broken page.
  const sandbox = new Sandbox({ dir: repo({ [PAGE]: '<script>let a = ;</script>\n', 'scripts/main-split-order.json': ORDER }) });
  await sandbox.check();
  const c = await change(sandbox, PAGE, '<script>let a = 1;</script>\n', 'C fix');
  const head = await sandbox.head();
  const r = await sandbox.revert({ sha: c.sha, user: 'minhoon', validate: files => buildAndCheck(sandbox.dir, files, { python: 'python' }) });
  assert.ok(r.error);
  assert.ok(r.errors.length);
  assert.strictEqual(await sandbox.head(), head);
  assert.strictEqual(read(sandbox.dir, PAGE), '<script>let a = 1;</script>\n');
  assert.deepStrictEqual(await sandbox.changes(), []);
});

test('a question keeps reading one revision while an edit commits; the read copy catches up afterwards', async () => {
  const sandbox = new Sandbox({ dir: repo(), readDir: path.join(tmp(), 'read') });
  await sandbox.check();
  const readHead = await sandbox.beginRead();
  const v1 = await change(sandbox, PAGE, '<p>v1</p>\n', 'v1');
  assert.strictEqual(read(sandbox.readDir, PAGE), '<p>v0</p>\n');
  assert.notStrictEqual(readHead, v1.sha);
  sandbox.endRead();
  await sandbox.readLock;
  assert.strictEqual(read(sandbox.readDir, PAGE), '<p>v1</p>\n');
  assert.strictEqual(await sandbox.beginRead(), v1.sha);
  sandbox.endRead();
});

test('a digest carries an unanswered request to the next one and reports a cut-off one', async () => {
  const sandbox = new Sandbox({ dir: repo() });
  await sandbox.check();
  const data = tmp();
  const chatFile = path.join(data, 'chat.jsonl');
  const at = ms => new Date(Date.now() - ms).toISOString();
  appendJsonl(chatFile, { t: at(3000), role: 'user', user: 'minhoon', mode: 'ask', text: '진행 중 질문', jobId: 'j1' });
  appendJsonl(chatFile, { t: at(2000), role: 'user', user: 'minhoon', mode: 'edit', text: '재시작에 끊긴 요청', jobId: 'j2' });
  const first = await writeDigest({ dataDir: data, sandbox, activeJobs: () => ['j1'] });
  assert.deepStrictEqual(first.summary.requests.map(r => [r.jobId, r.outcome]), [['j1', 'pending'], ['j2', 'interrupted']]);
  appendJsonl(chatFile, { t: new Date().toISOString(), role: 'assistant', mode: 'ask', text: '답입니다', jobId: 'j1', meta: {} });
  await new Promise(r => setTimeout(r, 5));
  const second = await writeDigest({ dataDir: data, sandbox, activeJobs: () => [] });
  assert.deepStrictEqual(second.summary.requests.map(r => [r.jobId, r.outcome, r.carriedFromPrevious]), [['j1', 'answered', true]]);
  assert.strictEqual(second.summary.requests[0].answer, '답입니다');
});

test('digests written at the same moment get distinct names that the read route accepts', async () => {
  const sandbox = new Sandbox({ dir: repo() });
  await sandbox.check();
  const data = tmp();
  const [a, b, c] = await Promise.all([1, 2, 3].map(() => writeDigest({ dataDir: data, sandbox })));
  assert.strictEqual(new Set([a.day, b.day, c.day]).size, 3);
  const names = listDigests(data);
  assert.strictEqual(names.length, 3);
  for (const name of names) assert.match(name, DIGEST_ID);
});

test('a reload that timed out is reported as such and kept out of the ready-time statistics', async () => {
  const sandbox = new Sandbox({ dir: repo() });
  await sandbox.check();
  const data = tmp();
  const t = new Date(Date.now() - 1000).toISOString();
  for (const [jobId, readyKind, reloadMs] of [['j3', 'timeout', 31001], ['j4', 'rows', 500]]) {
    appendJsonl(path.join(data, 'chat.jsonl'), { t, role: 'user', user: 'minhoon', mode: 'edit', text: jobId, jobId });
    appendJsonl(path.join(data, 'chat.jsonl'), { t, role: 'assistant', mode: 'edit', text: 'ok', jobId, meta: { changed: true, sha: 'abc' } });
    appendJsonl(path.join(data, 'metrics.jsonl'), { t, jobId, ok: true, changed: true, timings: { lastEditToReloadSentMs: 1000, totalToReloadSentMs: 5000 } });
    appendJsonl(path.join(data, 'metrics.jsonl'), { t, jobId, kind: 'reload-ready', reloadMs, readyKind });
  }
  const d = await writeDigest({ dataDir: data, sandbox });
  const [timedOut, ok] = d.summary.requests;
  assert.strictEqual(timedOut.reloadTimedOut, true);
  assert.strictEqual(timedOut.editToReadyMs, null);
  assert.strictEqual(ok.editToReadyMs, 1500);
  assert.strictEqual(d.summary.timing.editToReadyP50Ms, 1500);
  assert.strictEqual(d.summary.counts.reloadTimeouts, 1);
});

test('a digest takes its patch, commits and next boundary from one revision while edits and undos go on', async () => {
  const sandbox = new Sandbox({ dir: repo() });
  await sandbox.check();
  const data = tmp();
  const applied = await change(sandbox, PAGE, '<p>applied</p>\n', 'applied');
  // An ordinary edit commits just after the digest read the patch.
  const realDiff = sandbox.diffSinceBase.bind(sandbox);
  let next = null;
  sandbox.diffSinceBase = async rev => {
    const out = await realDiff(rev);
    if (!next) next = await change(sandbox, PAGE, '<p>next committed revision</p>\n', 'next');
    return out;
  };
  const first = await writeDigest({ dataDir: data, sandbox });
  sandbox.diffSinceBase = realDiff;
  assert.ok(next);
  const patch = fs.readFileSync(path.join(data, 'public', 'digests', `${first.day}.patch`), 'utf8');
  const git = (...args) => execFileSync('git', args, { cwd: sandbox.dir, encoding: 'utf8' });
  assert.strictEqual(patch, git('diff', `studio-base..${first.summary.head}`, '--', ...ALLOWED));
  assert.deepStrictEqual(first.summary.commits.map(c => c.sha), [first.summary.head]);
  // The next digest starts where the first one stopped, so the commit it did not describe is reported exactly once.
  const second = await writeDigest({ dataDir: data, sandbox });
  assert.strictEqual(second.summary.previousHead, first.summary.head);
  assert.deepStrictEqual([...first.summary.commits, ...second.summary.commits].map(c => c.sha).sort(), [applied.sha, next.sha].sort());
  assert.strictEqual(second.summary.head, next.sha);
  // A digest written while an undo is being checked (and then rolled back) describes the revision on screen.
  let during = null;
  const undo = await sandbox.revert({ user: 'minhoon', validate: async () => { during = await writeDigest({ dataDir: data, sandbox }); return { ok: false, errors: ['synthetic'] }; } });
  assert.ok(undo.error);
  assert.strictEqual(await sandbox.head(), next.sha);
  assert.strictEqual(during.summary.head, next.sha);
  assert.deepStrictEqual(during.summary.commits, []);
});

test('a reload outcome that arrives after the handoff is reported in the next one, once', async () => {
  const sandbox = new Sandbox({ dir: repo() });
  await sandbox.check();
  const data = tmp();
  const t = new Date(Date.now() - 1000).toISOString();
  appendJsonl(path.join(data, 'chat.jsonl'), { t, role: 'user', user: 'minhoon', mode: 'edit', text: 'j5', jobId: 'j5' });
  appendJsonl(path.join(data, 'chat.jsonl'), { t, role: 'assistant', mode: 'edit', text: 'ok', jobId: 'j5', meta: { changed: true, sha: 'abc' } });
  appendJsonl(path.join(data, 'metrics.jsonl'), { t, jobId: 'j5', ok: true, changed: true, timings: { lastEditToReloadSentMs: 1000, totalToReloadSentMs: 5000 } });
  const first = await writeDigest({ dataDir: data, sandbox });
  assert.deepStrictEqual(first.summary.requests.map(r => [r.jobId, r.outcome, r.reloadTimedOut]), [['j5', 'applied', false]]);
  assert.strictEqual(first.summary.counts.reloadTimeouts, 0);
  await new Promise(r => setTimeout(r, 5));
  appendJsonl(path.join(data, 'metrics.jsonl'), { t: new Date().toISOString(), jobId: 'j5', kind: 'reload-ready', reloadMs: 31001, readyKind: 'timeout' });
  await new Promise(r => setTimeout(r, 5));
  const second = await writeDigest({ dataDir: data, sandbox });
  assert.deepStrictEqual(second.summary.requests.map(r => [r.jobId, r.reloadOnly, r.reloadTimedOut]), [['j5', true, true]]);
  assert.strictEqual(second.summary.counts.reloadTimeouts, 1);
  assert.strictEqual(second.summary.counts.requests, 0, 'the request itself was counted in the first handoff');
  assert.strictEqual(second.summary.timing.editToReadyP50Ms, null);
  const third = await writeDigest({ dataDir: data, sandbox });
  assert.deepStrictEqual(third.summary.requests, []);
});

test('every digest name the writer can produce is accepted by the read route and listed newest first', () => {
  const data = tmp();
  const dir = path.join(data, 'public', 'digests');
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['2026-10-27', '2026-10-28', '2026-10-28-2', '2026-10-28-10', '2026-10-28-1000']) fs.writeFileSync(path.join(dir, `${name}.md`), '');
  const names = listDigests(data);
  assert.deepStrictEqual(names, ['2026-10-28-1000', '2026-10-28-10', '2026-10-28-2', '2026-10-28', '2026-10-27']);
  for (const name of names) assert.match(name, DIGEST_ID);
});

test('image metadata follows a changed synthetic identity', () => {
  const store = tmp();
  fs.writeFileSync(path.join(store, 'studies.json'), JSON.stringify([{ studyUid: '1.2.840.99', source: { folder: 'SAMPLE/A872279/1901-01-13' }, qido: {}, instanceCount: 1, seriesCount: 1 }]));
  fs.writeFileSync(path.join(store, 'routes.json'), JSON.stringify({ '/dicom-web/studies/1.2.840.99/metadata': { file: 'meta.json', type: 'application/dicom+json' } }));
  fs.writeFileSync(path.join(store, 'meta.json'), JSON.stringify([{ '00100010': { vr: 'PN', Value: [{ Alphabetic: 'SOURCE^NAME' }] }, '0020000D': { vr: 'UI', Value: ['1.2.840.99'] } }]));
  const dicomweb = new DicomWeb(store);
  const sandboxDir = tmp();
  const datasetFile = path.join(sandboxDir, 'studio-mock/dataset.json');
  fs.mkdirSync(path.dirname(datasetFile));
  const seed = JSON.parse(fs.readFileSync(path.join(SEED, 'studio-mock/dataset.json'), 'utf8'));
  const setName = name => { seed.patients.find(p => p.key === 'P1').name = name; fs.writeFileSync(datasetFile, JSON.stringify(seed)); };
  setName('SYNTHETIC FIRST');
  const mock = new Mock({ dataDir: tmp(), sandboxDir, dicomweb });
  const fetchName = () => {
    let body = null;
    const res = { writeHead() {}, end(data) { body = data; } };
    dicomweb.handle({ method: 'GET' }, res, new URL('http://studio.test/dicom-web/studies/2.25.202610270001/metadata'), mock.dataset(), 'http://studio.test');
    return JSON.parse(String(body))[0]['00100010'].Value[0].Alphabetic;
  };
  assert.strictEqual(fetchName(), 'SYNTHETIC^FIRST');
  setName('SYNTHETIC SECOND NAME');
  assert.strictEqual(fetchName(), 'SYNTHETIC^SECOND NAME');
});
