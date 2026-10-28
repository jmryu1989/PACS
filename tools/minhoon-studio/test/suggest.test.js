'use strict';
// 먼저 제안하기 on real git sandboxes and data folders: when a suggestion is prepared, what the preview serves, apply
// as an undoable change, answers remembered, the screen moving on, and the digest. The Claude CLI is replaced by a
// stub that edits the folder it is given and returns its result shape. Run command in the README.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Sandbox } = require('../server/sandbox');
const { Chat } = require('../server/chat');
const { StatusFeed } = require('../server/status');
const { Suggestions, parseSuggestion } = require('../server/suggest');
const { StaticServer } = require('../server/static');
const { writeDigest } = require('../server/digest');
const { readJsonl } = require('../server/util');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mstudio-suggest-'));
const PAGE = 'worklist-v0/hpacs-lite/main.html';
const CSS = 'worklist-v0/hpacs-lite/main.css';
const ORDER = JSON.stringify({ page: PAGE, sources: [], artifact: 'worklist-v0/hpacs-lite/main-split.bundle.js' });
const FEEDBACK = '# Feedback\n\n8. **Report editor layout.**\n   - put Clinical Context beside the editor;\n11. **Colours.**\n    - Sky blue is for selected states and accents, not body text.\n';

function repo() {
  const dir = tmp();
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir });
  git('init', '-q');
  git('config', 'core.autocrlf', 'false');
  for (const [file, text] of Object.entries({ [PAGE]: '<p>v0</p>\n', [CSS]: 'body { color: #8ab4c8; }\n.row { padding: 2px; }\n', 'scripts/main-split-order.json': ORDER })) write(dir, file, text);
  git('add', '-A'); git('commit', '-q', '-m', 'base'); git('tag', 'studio-base');
  return dir;
}
function write(dir, file, text) { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); }
const read = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf8');
const cli = extra => ({ text: '', model: 'stub', tools: [], edits: [], denials: [], t: { spawn: Date.now(), done: Date.now() }, sawResult: true, exitCode: 0, ...extra });
const block = value => `만들어 두었습니다.\n<studio-suggestion>${JSON.stringify(value)}</studio-suggestion>`;
const SUGGESTION = { key: 'body-text-not-sky-blue', kind: 'critique', title: '본문 글자를 하늘색 대신 #e3e3e3로', why: '하늘색은 선택 표시용이라고 하셨습니다.',
  grounds: [{ kind: 'feedback', ref: '11', quote: 'Sky blue is for selected states and accents, not body text.' }, { kind: 'screen', ref: `${CSS}:1` }],
  request: '본문 글자색을 #e3e3e3로 바꿔 주세요' };

async function setup({ claude } = {}) {
  const sandbox = new Sandbox({ dir: repo() });
  await sandbox.check();
  const data = tmp(), knowledge = tmp();
  fs.writeFileSync(path.join(knowledge, 'minhoon-feedback.md'), FEEDBACK);
  const events = [];
  const config = { claude: { python: 'python', shellTool: 'Bash', account: 'a', configDirs: { a: data }, models: { deep: 'opus' } } };
  const broadcast = e => events.push(e);
  const chat = new Chat({ config, sandbox, dataDir: data, broadcast, statusFeed: new StatusFeed(knowledge) });
  const prompts = [];
  chat.claude = async (job, mode, prompt) => {
    prompts.push({ mode, prompt, cwd: chat.dirs[mode] });
    return (claude || defaultClaude)(chat.dirs[mode], mode, prompt, job);
  };
  const s = new Suggestions({ config, sandbox, chat, dataDir: data, statusFeed: new StatusFeed(knowledge), broadcast,
    previewDir: path.join(tmp(), 'preview'), feedbackFile: path.join(knowledge, 'minhoon-feedback.md') });
  await s.init();
  return { sandbox, chat, s, data, events, prompts };
}
function defaultClaude(dir, mode) {
  if (mode === 'suggest') { write(dir, CSS, 'body { color: #e3e3e3; }\n.row { padding: 2px; }\n'); return cli({ text: block(SUGGESTION) }); }
  write(dir, PAGE, '<p>edited by request</p>\n');
  return cli({ text: '고쳤습니다.' });
}
const settle = async s => { while (s.preparing) await s.preparing; await s.chat.queue; await s.lock; };
const req = cookie => ({ headers: { cookie } });

test('a suggestion is grounded only by feedback it quotes as written and files that exist', () => {
  const ok = parseSuggestion(block(SUGGESTION), { feedback: FEEDBACK, fileExists: f => f === CSS });
  assert.strictEqual(ok.suggestion.grounds.length, 2);
  const misquoted = parseSuggestion(block({ ...SUGGESTION, grounds: [{ kind: 'feedback', ref: '11', quote: 'Sky blue must never be used' }] }), { feedback: FEEDBACK });
  assert.strictEqual(misquoted.error, 'ungrounded');
  const noSuchItem = parseSuggestion(block({ ...SUGGESTION, grounds: [{ kind: 'feedback', ref: '42', quote: '' }] }), { feedback: FEEDBACK });
  assert.strictEqual(noSuchItem.error, 'ungrounded');
  const noSuchFile = parseSuggestion(block({ ...SUGGESTION, grounds: [{ kind: 'screen', ref: 'worklist-v0/hpacs-lite/nope.js:3' }] }), { feedback: FEEDBACK, fileExists: () => false });
  assert.strictEqual(noSuchFile.error, 'ungrounded');
  const practice = parseSuggestion(block({ ...SUGGESTION, grounds: [{ kind: 'practice', ref: '이전 검사 나란히 비교' }] }), { feedback: FEEDBACK });
  assert.ok(practice.suggestion);
  assert.deepStrictEqual(parseSuggestion(block({ none: true, why: '지금은 없음' })), { none: true, why: '지금은 없음' });
  assert.strictEqual(parseSuggestion('블록 없음').error, 'no-block');
});

test('nothing is prepared while he types, while a request runs, or with no studio open; then exactly one is', async () => {
  let release;
  const { s, chat, prompts } = await setup();
  assert.strictEqual(s.maybePrepare('test'), false, 'no studio tab open');
  s.presence('tab1', 'minhoon', { typing: true, page: '/worklist/hpacs-lite/main.html' });
  assert.strictEqual(s.preparing, null, 'typing');
  chat.pending = 1;
  s.presence('tab1', 'minhoon', { typing: false, page: '/worklist/hpacs-lite/main.html' });
  assert.strictEqual(s.preparing, null, 'a request is running');
  chat.pending = 0;
  const gate = new Promise(r => { release = r; });
  const real = chat.claude;
  chat.claude = async (...args) => { await gate; return real(...args); };
  s.presence('tab1', 'minhoon', { typing: false, page: '/worklist/hpacs-lite/main.html' });
  assert.ok(s.preparing);
  s.presence('tab1', 'minhoon', { typing: false });
  release();
  await settle(s);
  const ready = s.current();
  assert.strictEqual(ready.status, 'ready');
  assert.strictEqual(prompts.length, 1, 'one suggestion at a time');
  assert.match(prompts[0].prompt, /Sky blue is for selected states/, 'his feedback is in the prompt');
  assert.match(prompts[0].prompt, /main\.html/, 'the screen he is on is in the prompt');
  assert.strictEqual(s.maybePrepare('again'), false, 'the open one waits for his answer');
});

test('the preview is built in its own copy: the studio screen is untouched until 적용, which is an undoable change', async () => {
  const { s, sandbox, data } = await setup();
  const before = await sandbox.head();
  s.presence('tab1', 'minhoon', { typing: false });
  await settle(s);
  const item = s.current();
  assert.strictEqual(await sandbox.head(), before);
  assert.strictEqual(read(sandbox.dir, CSS), 'body { color: #8ab4c8; }\n.row { padding: 2px; }\n');
  assert.deepStrictEqual(await sandbox.changes(), []);
  // The mirror serves the preview copy only to the browser holding this suggestion's cookie.
  assert.strictEqual(s.previewRoot(req(`mstudio_preview=${item.id}`)), s.previewDir);
  assert.strictEqual(s.previewRoot(req('mstudio_preview=deadbeef')), null);
  assert.strictEqual(s.previewRoot(req('')), null);
  const statics = new StaticServer({ sandbox: sandbox.dir, ohifDist: tmp(), uiDir: tmp(), previewRoot: r => s.previewRoot(r) });
  const served = cookie => { let body = null; statics.handle({ method: 'GET', headers: { cookie } }, { writeHead() {}, end(b) { body = String(b); } }, new URL('http://studio.test/worklist/hpacs-lite/main.css')); return body; };
  assert.match(served(`mstudio_preview=${item.id}`), /#e3e3e3/);
  assert.match(served(''), /#8ab4c8/);

  const r = await s.apply(item.id, { user: 'minhoon', displayName: '민훈' });
  assert.strictEqual(r.via, 'preview');
  assert.match(read(sandbox.dir, CSS), /#e3e3e3/);
  const [commit] = await sandbox.log();
  assert.strictEqual(commit.trailers['Studio-Kind'], 'change');
  assert.strictEqual(commit.trailers['Studio-Suggestion'], item.id);
  assert.strictEqual(s.previewRoot(req(`mstudio_preview=${item.id}`)), null, 'an answered suggestion is no longer served');
  const undo = await sandbox.revert({ user: 'minhoon' });
  assert.strictEqual(undo.reverted.sha, commit.sha);
  assert.match(read(sandbox.dir, CSS), /#8ab4c8/);
  const events = readJsonl(path.join(data, 'public', 'suggestions.jsonl')).map(e => e.event);
  assert.deepStrictEqual(events.filter(e => ['prepared', 'applied'].includes(e)), ['prepared', 'applied']);
});

test('declined and skipped suggestions are remembered: the same idea is not offered again', async () => {
  const { s, prompts } = await setup();
  s.presence('tab1', 'minhoon', { typing: false });
  await settle(s);
  const first = s.current();
  s.noted(first.id, 'shown', { by: 'minhoon' });
  s.answer(first.id, 'declined', 'minhoon');
  await settle(s);
  assert.match(prompts[1].prompt, /\[body-text-not-sky-blue\] 본문 글자를 하늘색 대신 #e3e3e3로 — 됐어요/, 'the next prompt lists it');
  const repeat = s.items().find(i => i.id !== first.id);
  assert.strictEqual(repeat.status, 'failed');
  assert.strictEqual(repeat.error, 'repeat');
  assert.strictEqual(s.current(), null);
  assert.strictEqual(s.maybePrepare('presence'), false, 'after a turn that produced nothing, wait for his next activity');
});

test('the screen moving on rebuilds the preview on top of it; a preview that no longer fits is set aside', async () => {
  const { s, sandbox, chat } = await setup();
  s.presence('tab1', 'minhoon', { typing: false });
  await settle(s);
  const item = s.current();
  // His own edit elsewhere: the preview follows it and keeps the suggestion.
  chat.enqueue({ user: 'minhoon', displayName: '민훈', mode: 'edit', text: '페이지 글자' });
  await settle(s);
  await s.followHead(); await s.lock;
  const moved = s.current();
  assert.strictEqual(moved.id, item.id);
  assert.notStrictEqual(moved.baseSha, item.baseSha);
  assert.strictEqual(read(s.previewDir, PAGE), '<p>edited by request</p>\n');
  assert.match(read(s.previewDir, CSS), /#e3e3e3/);
  assert.strictEqual(s.previewRoot(req(`mstudio_preview=${item.id}`)), s.previewDir);
  // A change to the same line: the preview no longer applies and is put aside, not shown half-applied.
  write(sandbox.dir, CSS, 'body { color: #b4b4b4; }\n.row { padding: 2px; }\n');
  await sandbox.commit({ subject: 'same line', trailers: { 'Studio-Kind': 'change', 'Studio-User': 'minhoon' } });
  await s.followHead(); await s.lock;
  const stale = s.items().find(i => i.id === item.id);
  assert.strictEqual(stale.status, 'stale');
  assert.strictEqual(s.previewRoot(req(`mstudio_preview=${item.id}`)), null);
});

test('an answer given while the preview is being rebuilt stays answered, and the next suggestion starts', async () => {
  const { s, sandbox, prompts } = await setup();
  s.presence('tab1', 'minhoon', { typing: false });
  await settle(s);
  const item = s.current();
  write(sandbox.dir, PAGE, '<p>his own change</p>\n');
  await sandbox.commit({ subject: 'his change', trailers: { 'Studio-Kind': 'change', 'Studio-User': 'minhoon' } });
  // Hold the rebuild at its preview commit (built and checked, not yet recorded): the answer arrives in that window.
  let release, reached;
  const gate = new Promise(r => { release = r; });
  const atCommit = new Promise(r => { reached = r; });
  const commit = s.preview.commit.bind(s.preview);
  s.preview.commit = async (...args) => { reached(); await gate; return commit(...args); };
  const rebuilding = s.followHead();
  await atCommit;
  assert.deepStrictEqual(s.answer(item.id, 'skipped', 'minhoon'), { ok: true });
  release();
  await rebuilding;
  s.preview.commit = commit;
  await settle(s);
  const after = s.items().find(i => i.id === item.id);
  assert.strictEqual(after.status, 'skipped', 'the rebuild did not bring it back');
  assert.strictEqual(s.previewRoot(req(`mstudio_preview=${item.id}`)), null);
  assert.strictEqual(prompts.filter(p => p.mode === 'suggest').length, 2, 'the next suggestion was prepared');
});

test('적용 after a conflicting change builds the same request as an ordinary edit', async () => {
  const { s, sandbox, chat } = await setup();
  s.presence('tab1', 'minhoon', { typing: false });
  await settle(s);
  const item = s.current();
  // The head moves under a ready suggestion without the rebase having run yet.
  write(sandbox.dir, CSS, 'body { color: #b4b4b4; }\n.row { padding: 2px; }\n');
  await sandbox.commit({ subject: 'same line', trailers: { 'Studio-Kind': 'change', 'Studio-User': 'minhoon' } });
  const asked = [];
  const real = chat.claude;
  chat.claude = async (job, mode, prompt) => { if (mode === 'edit') asked.push(job.text); return real(job, mode, prompt); };
  const r = await s.apply(item.id, { user: 'minhoon', displayName: '민훈' });
  assert.strictEqual(r.via, 'edit');
  await settle(s);
  assert.match(asked[0], /본문 글자색을 #e3e3e3로/);
});

test('the digest lists every suggestion with its grounds, timings and his answer', async () => {
  const { s, sandbox, data } = await setup();
  s.presence('tab1', 'minhoon', { typing: false });
  await settle(s);
  const item = s.current();
  s.noted(item.id, 'shown', { by: 'minhoon' });
  s.noted(item.id, 'previewed', { by: 'minhoon' });
  s.noted(item.id, 'preview-ready', { by: 'minhoon', clickToReadyMs: 900, reloadMs: 800, readyKind: 'rows' });
  s.answer(item.id, 'skipped', 'minhoon');
  await settle(s);
  const d = await writeDigest({ dataDir: data, sandbox });
  const row = d.summary.suggestions.find(r => r.id === item.id);
  assert.strictEqual(row.outcome, 'skipped');
  assert.strictEqual(row.by, 'minhoon');
  assert.deepStrictEqual(row.previewMs, [900]);
  assert.strictEqual(row.grounds[0].ref, '11');
  assert.strictEqual(d.summary.suggestionTiming.previewClickToReadyP50Ms, 900);
  const md = fs.readFileSync(d.file, 'utf8');
  assert.match(md, /## 스튜디오가 먼저 한 제안과 답/);
  assert.match(md, /본문 글자를 하늘색 대신 #e3e3e3로.*feedback 11.*다른 제안.*minhoon/);
});

test('a restart drops a half-made suggestion and keeps a ready one only if its preview still exists', async () => {
  const { s, sandbox, chat, data, events } = await setup();
  s.presence('tab1', 'minhoon', { typing: false });
  await settle(s);
  const items = s.items();
  items.push({ id: 'abcdef12', t: new Date().toISOString(), status: 'preparing' });
  fs.writeFileSync(path.join(data, 'suggestions.json'), JSON.stringify({ items }));
  const again = new Suggestions({ config: chat.config, sandbox, chat, dataDir: data, statusFeed: s.statusFeed, broadcast: e => events.push(e),
    previewDir: s.previewDir, feedbackFile: s.feedbackFile });
  await again.init();
  const after = again.items();
  assert.strictEqual(after.find(i => i.id === 'abcdef12').status, 'interrupted');
  assert.strictEqual(after.find(i => i.id === items[0].id).status, 'ready');
  assert.strictEqual(again.previewRoot(req(`mstudio_preview=${items[0].id}`)), again.previewDir);
});
