'use strict';
// Real HTTP chat route, storage, history and digest; only the external Claude process is replaced.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { once } = require('events');

test('chat attachments enforce the owner limits and reach edit/ask prompts, history and digest', { timeout: 60000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-attach-'));
  const studio = path.resolve(__dirname, '..');
  const sandbox = path.join(root, 'sandbox'), data = path.join(root, 'data');
  fs.mkdirSync(sandbox); fs.mkdirSync(data);
  fs.writeFileSync(path.join(sandbox, 'README.md'), 'Synthetic attachment route fixture\n');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: sandbox, stdio: 'pipe' });
  git('init', '-q'); git('add', 'README.md'); git('commit', '-qm', 'fixture'); git('tag', 'studio-base');
  const config = { listen: { host: '127.0.0.1', port: 0 }, paths: { sandbox, sandboxRead: path.join(root, 'read'), data,
    knowledge: path.join(studio, 'knowledge-seed'), ohifDist: root, dicomweb: root }, suggest: { enabled: false },
    claude: { bin: 'unused', account: 'fixture', configDirs: { fixture: root }, python: 'python', shellTool: 'PowerShell' } };
  const cfg = path.join(root, 'config.json'); fs.writeFileSync(cfg, JSON.stringify(config));
  const preload = path.join(root, 'cli.cjs');
  fs.writeFileSync(preload, `
    const fs = require('fs');
    const http = require('http');
    const listen = http.Server.prototype.listen;
    http.Server.prototype.listen = function(...args) { this.once('listening', () => console.log('PORT=' + this.address().port)); return listen.apply(this, args); };
    const { Chat } = require(${JSON.stringify(path.join(studio, 'server/chat.js'))});
    Chat.prototype.claude = async function(job, mode, prompt) {
      fs.appendFileSync(${JSON.stringify(path.join(root, 'prompts.jsonl'))}, JSON.stringify({mode, prompt, images: job.context.images}) + '\\n');
      return { text: '첨부 확인', sawResult: true, exitCode: 0, tools: [], edits: [], denials: [], t: {} };
    };
  `);
  const serverJs = path.join(studio, 'server/server.js');
  execFileSync(process.execPath, [serverJs, 'set-password', 'fixture', 'Synthetic', '--config', cfg], { input: 'synthetic-fixture-only\n' });
  const child = spawn(process.execPath, ['--require', preload, serverJs, '--config', cfg], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  t.after(async () => { child.kill(); if (child.exitCode === null) await once(child, 'exit'); fs.rmSync(root, { recursive: true, force: true }); });
  let log = '';
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server startup timeout: ' + log)), 10000);
    child.stderr.on('data', b => { log += b; });
    child.stdout.on('data', b => { log += b; const m = log.match(/PORT=(\d+)/); if (m) { clearTimeout(timer); resolve(m[1]); } });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`server exit ${code}: ${log}`)); });
  });
  const base = `http://127.0.0.1:${port}/studio-api/`;
  const login = await fetch(base + 'login', { method: 'POST', body: JSON.stringify({ user: 'fixture', password: 'synthetic-fixture-only' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const post = (route, value) => fetch(base + route, { method: 'POST', headers: { Cookie: cookie, 'X-Studio': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  const history = () => fetch(base + 'history', { headers: { Cookie: cookie } }).then(r => r.json());
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
  const image = { type: 'image/png', data: png.toString('base64'), width: 1, height: 1 };
  const jpeg = { ...image, type: 'image/jpeg', data: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==' };
  const send = (images, mode = 'ask') => post('chat', { text: '그림 확인', mode, context: { images, picks: [{ tag: 'button', text: 'Save' }] } });
  assert.equal((await send(Array(5).fill(image))).status, 400);
  assert.equal((await send([{ ...image, data: Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64') }])).status, 400);
  assert.deepEqual(await history(), []);
  assert.deepEqual(fs.readdirSync(path.join(data, 'uploads')), []);
  const accepted = [];
  // Four full-size files prove that the route-specific JSON allowance includes base64 expansion.
  const full = { ...image, data: Buffer.concat([png, Buffer.alloc(8 * 1024 * 1024 - png.length)]).toString('base64') };
  for (const [mode, images] of [['ask', Array(4).fill(full)], ['edit', [image, jpeg]]]) {
    const response = await send(images, mode); assert.equal(response.status, 202);
    const { jobId } = await response.json(); accepted.push(jobId);
    const end = Date.now() + 10000;
    while (!(await history()).some(r => r.jobId === jobId && r.role === 'assistant') && Date.now() < end) await new Promise(r => setTimeout(r, 20));
    const rows = await history(), user = rows.find(r => r.jobId === jobId && r.role === 'user');
    assert.equal(user.meta.images.length, images.length); assert.ok(user.meta.picks[0].includes('Save'));
    assert.ok(rows.some(r => r.jobId === jobId && r.role === 'assistant' && !r.meta?.failed));
    for (let i = 0; i < images.length; i++) {
      assert.match(user.meta.images[i], new RegExp(`^uploads/\\d{4}-\\d{2}-\\d{2}/${jobId}-${i + 1}\\.(png|jpg)$`));
      assert.ok(fs.readFileSync(path.join(data, user.meta.images[i])).equals(Buffer.from(images[i].data, 'base64')));
    }
  }
  const prompts = fs.readFileSync(path.join(root, 'prompts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(prompts.map(p => p.mode), ['ask', 'edit']);
  for (const p of prompts) for (const image of p.images) {
    assert.ok(p.prompt.includes(path.resolve(data, image.path))); assert.ok(p.prompt.includes('(1×1)')); assert.ok(p.prompt.includes('Read'));
    assert.equal(image.data, undefined);
  }
  const digest = await post('digest', {}); assert.equal(digest.status, 200);
  const digestDir = path.join(data, 'public/digests');
  const md = fs.readFileSync(path.join(digestDir, fs.readdirSync(digestDir).find(n => n.endsWith('.md'))), 'utf8');
  assert.ok(md.includes('그림 4장')); assert.ok(md.includes('그림 2장'));
  for (const id of accepted) assert.ok(md.includes(id + '-1.png'));
  assert.equal(git('status', '--porcelain').toString(), '');
});
