#!/usr/bin/env node
'use strict';
// Minhoon studio: one small Node service (decision D11). Left: the product screens served from the studio sandbox
// against a synthetic mock API. Right: a Korean chat with the Claude Code CLI that edits those screens.
//   node server.js --config <config.json>                 run the studio
//   node server.js set-password <name> "<display>" --config <config.json>   (password on stdin)
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { execFile } = require('child_process');
const { send, sendJson, readJson, appendJsonl, readJsonl, maskSecrets, readJsonFile } = require('./util');
const { Auth, setPasswordFromStdin } = require('./auth');
const { StaticServer, ISOLATION } = require('./static');
const { DicomWeb } = require('./dicomweb');
const { Mock } = require('./mock');
const { Sandbox } = require('./sandbox');
const { Chat, MAX_PICKS } = require('./chat');
const { StatusFeed } = require('./status');
const { writeDigest, listDigests, DIGEST_ID } = require('./digest');
const { buildAndCheck } = require('./build');
const { Suggestions } = require('./suggest');

function loadConfig(argv) {
  const i = argv.indexOf('--config');
  const file = path.resolve(i >= 0 ? argv[i + 1] : process.env.STUDIO_CONFIG || path.join(__dirname, '../config.local.json'));
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rel = p => (p && !path.isAbsolute(p) ? path.resolve(path.dirname(file), p) : p);
  for (const key of Object.keys(config.paths)) config.paths[key] = rel(config.paths[key]);
  if (config.tls) { config.tls.cert = rel(config.tls.cert); config.tls.key = rel(config.tls.key); }
  for (const [name, dir] of Object.entries(config.claude.configDirs || {})) config.claude.configDirs[name] = rel(dir);
  config.claude.bin = rel(config.claude.bin);
  config.file = file;
  return config;
}

async function main() {
  const argv = process.argv.slice(2);
  const config = loadConfig(argv);
  if (argv[0] === 'set-password') {
    await setPasswordFromStdin(config.paths.data, argv[1], argv[2]);
    console.log(`password set for ${argv[1]}`);
    return;
  }
  fs.mkdirSync(path.join(config.paths.data, 'public'), { recursive: true });
  const clients = new Set();
  // Each reload event gets its own id: every chat tab relays it to the product window, which reloads once per id.
  // Without it two mock resets (no sha, no job) looked like one event and the second never reloaded the screen.
  let eventSeq = 0;
  const started = Date.now().toString(36);
  const broadcast = event => {
    if (event.type === 'reload') event = { ...event, eventId: `${started}-${++eventSeq}` };
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of clients) res.write(data);
  };
  const auth = new Auth(config.paths.data);
  const sandbox = new Sandbox({ dir: config.paths.sandbox, readDir: config.paths.sandboxRead });
  await sandbox.check();
  let suggestions = null;
  const statics = new StaticServer({ sandbox: config.paths.sandbox, ohifDist: config.paths.ohifDist, uiDir: path.join(__dirname, '../ui'),
    previewRoot: req => (suggestions ? suggestions.previewRoot(req) : null) });
  const dicomweb = new DicomWeb(config.paths.dicomweb);
  const missingFile = path.join(config.paths.data, 'missing.jsonl');
  const mock = new Mock({
    dataDir: config.paths.data, sandboxDir: config.paths.sandbox, dicomweb,
    onMissing: entry => { const item = { t: new Date().toISOString(), ...entry }; appendJsonl(missingFile, item); broadcast({ type: 'missing', ...item }); },
  });
  const statusFeed = new StatusFeed(config.paths.knowledge);
  const chat = new Chat({ config, sandbox, dataDir: config.paths.data, broadcast, statusFeed });
  // The preview copy lives beside the sandbox unless configured (install.sh creates it for the studio user).
  suggestions = new Suggestions({ config, sandbox, chat, dataDir: config.paths.data, statusFeed, broadcast,
    previewDir: config.paths.sandboxPreview || path.join(path.dirname(config.paths.sandbox), 'sandbox-preview'),
    feedbackFile: config.paths.feedback || path.join(config.paths.knowledge, 'minhoon-feedback.md') });
  await suggestions.init();
  let lastActivity = Date.now(), lastDigest = 0;
  const touch = () => { lastActivity = Date.now(); };

  // ~60 minutes without activity closes the day's digest (the commander's original brief); "오늘 끝" does it at once.
  const idleMinutes = (config.digest && config.digest.idleMinutes) || 60;
  setInterval(async () => {
    if (lastActivity > lastDigest && Date.now() - lastActivity > idleMinutes * 60e3 && !chat.pending) {
      lastDigest = Date.now();
      try { const d = await writeDigest({ dataDir: config.paths.data, sandbox, reason: 'idle', activeJobs: () => chat.activeJobIds() }); broadcast({ type: 'digest', day: d.day, reason: 'idle' }); }
      catch (error) { console.error('digest failed', error); }
    }
  }, 60e3).unref();

  let claudeStatus = { checked: 0, value: null };
  const checkClaude = () => new Promise(resolve => {
    if (Date.now() - claudeStatus.checked < 60e3 && claudeStatus.value) return resolve(claudeStatus.value);
    const { account, dir } = chat.claudeConfigDir();
    const env = { ...process.env, CLAUDE_CONFIG_DIR: dir, DISABLE_AUTOUPDATER: '1' };
    delete env.ANTHROPIC_API_KEY;
    execFile(config.claude.bin, ['auth', 'status', '--json'], { env, timeout: 20e3, windowsHide: true }, (error, stdout) => {
      let parsed = null; try { parsed = JSON.parse(String(stdout)); } catch { /* not logged in prints text */ }
      const value = { account, loggedIn: !!(parsed && (parsed.loggedIn || parsed.logged_in || parsed.authenticated)), model: config.claude.model || '(account default)',
        detail: parsed ? JSON.parse(maskSecrets(JSON.stringify({ subscriptionType: parsed.subscriptionType, authMethod: parsed.authMethod, apiProvider: parsed.apiProvider }))) : null,
        error: error && !parsed ? 'not logged in or CLI unavailable' : null };
      claudeStatus = { checked: Date.now(), value };
      resolve(value);
    });
  });

  const handler = async (req, res) => {
    const secure = !!config.tls;
    const origin = `${secure ? 'https' : 'http'}://${req.headers.host}`;
    let url;
    try { url = new URL(req.url, origin); } catch { send(res, 400, 'bad request'); return; }
    const p = url.pathname;

    // ── public: login ──
    if (p === '/studio/login.html' || p === '/studio/login.js' || p === '/studio/studio.css' || p === '/studio/favicon.svg') {
      statics.handle(req, res, url); return;
    }
    if (p === '/studio-api/login' && req.method === 'POST') {
      if (!sameOrigin(req, origin)) { sendJson(res, 403, { error: 'origin' }); return; }
      const body = await readJson(req, 4096).catch(() => ({}));
      const r = auth.login(String(body.user || '').trim().toLowerCase(), body.password);
      if (r.error) { sendJson(res, 401, { error: '이름 또는 비밀번호가 맞지 않습니다.' }); return; }
      sendJson(res, 200, { user: r.user, displayName: r.displayName }, { 'Set-Cookie': auth.cookie(r.sid, secure) });
      return;
    }
    const session = auth.sessionOf(req);
    if (!session) {
      if (p.startsWith('/studio-api/') || p.startsWith('/api/') || p.startsWith('/dicom-web/')) { sendJson(res, 401, { error: 'login required', code: 'STUDIO_LOGIN_REQUIRED' }); return; }
      res.writeHead(302, { Location: '/studio/login.html', 'Cache-Control': 'no-store' }); res.end(); return;
    }
    const user = session.user;

    // ── studio API ──
    if (p.startsWith('/studio-api/')) {
      if (req.method !== 'GET' && (!sameOrigin(req, origin) || req.headers['x-studio'] !== '1')) { sendJson(res, 403, { error: 'csrf' }); return; }
      try { await studioApi(req, res, url, session); } catch (error) { console.error(error); sendJson(res, error.status || 500, { error: maskSecrets(String(error.message || error)) }); }
      return;
    }
    if (p === '/' || p === '/studio' || p === '/studio/') { res.writeHead(302, { Location: '/studio/studio.html', 'Cache-Control': 'no-store' }); res.end(); return; }

    // ── mirror ──
    if (statics.handle(req, res, url)) return;
    if (p.startsWith('/dicom-web/') || p === '/dicom-web' || /^\/instances\/[0-9a-f-]+\//.test(p)) {
      if (!dicomweb.available()) { sendJson(res, 501, { code: 'STUDIO_NOT_SUPPORTED', message: '스튜디오 영상 표본이 설치되지 않았습니다(Viewer — Prototype pending).' }); return; }
      dicomweb.handle(req, res, url, mock.dataset(), origin); return;
    }
    if (p.startsWith('/api/') || p === '/statistics' || p === '/system' || p.startsWith('/auth/')) {
      await mock.handle(req, res, url, { user, displayName: session.displayName, origin });
      return;
    }
    send(res, 404, 'not found', { ...ISOLATION, 'Content-Type': 'text/plain; charset=utf-8' });
  };

  // Clears this browser's preview cookie when it has one (an answer, an apply, his own request or undo).
  const endPreview = req => (suggestions.previewId(req) ? { 'Set-Cookie': suggestions.clearCookie(!!config.tls) } : undefined);

  async function studioApi(req, res, url, session) {
    const p = url.pathname.slice('/studio-api/'.length);
    const user = session.user;
    const method = req.method;
    let m;
    if (p === 'events' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      // The suggestion state comes with the first event (and again on every reconnect): a tab opened while a request
      // runs or someone types must not show the card until the next change.
      res.write(`data: ${JSON.stringify({ type: 'hello', head: await sandbox.head(), queue: chat.status(), suggest: suggestions.state(req) })}\n\n`);
      clients.add(res);
      // A chat tab names itself on its event stream; its presence (typing or not) ends when the stream closes.
      const tab = String(url.searchParams.get('tab') || '').slice(0, 40);
      const ping = setInterval(() => res.write(': ping\n\n'), 25e3);
      req.on('close', () => { clearInterval(ping); clients.delete(res); if (tab) suggestions.dropTab(tab); });
      return;
    }
    if (p === 'state' && method === 'GET') {
      const log = await sandbox.log();
      sendJson(res, 200, {
        user, displayName: session.displayName, role: mock.role(user), roles: ['radiologist', 'technician', 'clinician', 'admin'],
        sandbox: { head: await sandbox.head(), base: await sandbox.base(), branch: await sandbox.branch(), changes: log.length,
          undoable: log.filter(c => c.trailers['Studio-Kind'] === 'change' && !c.reverted).length },
        mock: mock.describe(), viewer: dicomweb.available(), status: statusFeed.view().present ? { publishedAt: statusFeed.view().publishedAt, overdue: statusFeed.view().overdue } : null,
        queue: chat.status(), claude: { account: chat.claudeConfigDir().account, model: config.claude.model || null, ...chat.modelFor(user) },
      });
      return;
    }
    if (p === 'claude' && method === 'GET') { sendJson(res, 200, await checkClaude()); return; }
    if (p === 'history' && method === 'GET') { sendJson(res, 200, chat.history(Number(url.searchParams.get('limit') || 300))); return; }
    if (p === 'chat' && method === 'POST') {
      const body = await readJson(req, 256 * 1024);
      const text = String(body.text || '').trim();
      if (!text) { sendJson(res, 400, { error: '내용이 비었습니다.' }); return; }
      const picked = body.context && Array.isArray(body.context.picks) ? body.context.picks.length : 0;
      if (picked > MAX_PICKS) { sendJson(res, 400, { error: `고른 곳이 ${picked}개입니다. 한 번에 ${MAX_PICKS}개까지 보낼 수 있습니다.` }); return; }
      touch();
      const job = chat.enqueue({ user, displayName: session.displayName, mode: body.mode === 'ask' ? 'ask' : 'edit', text, context: { ...(body.context || {}), role: mock.role(user) } });
      // A request of his own ends a preview in this browser: the reload after his edit must show his screen.
      sendJson(res, 202, { jobId: job.id }, endPreview(req));
      return;
    }
    if (p === 'undo' && method === 'POST') {
      const body = await readJson(req, 4096);
      touch();
      // Same writer queue as edits; the result is rebuilt and checked like an edit before it reaches the mirror.
      const validate = files => buildAndCheck(sandbox.dir, files, { python: config.claude.python });
      const run = chat.queue.then(() => sandbox.revert({ sha: typeof body.sha === 'string' ? body.sha : null, user, withLater: body.withLater === true, validate }));
      chat.queue = run.catch(() => {});
      const result = await run;
      if (result.error) { sendJson(res, 409, { error: result.error, code: result.code || null, later: result.later || null, errors: (result.errors || []).slice(0, 5).map(maskSecrets) }); return; }
      const names = result.undone.map(i => i.subject);
      chat.log({ role: 'system', user, displayName: session.displayName, mode: 'edit', text: `되돌림: ${names.join(' / ')}`,
        meta: { sha: result.sha, reverted: result.reverted.sha, undone: result.undone.map(i => i.sha) } });
      broadcast({ type: 'reload', reason: 'undo', sha: result.sha });
      chat.onActivity();
      suggestions.followHead().catch(e => console.error('suggestion rebase failed', e));
      sendJson(res, 200, { sha: result.sha, reverted: result.reverted, undone: result.undone.map(i => ({ sha: i.sha, subject: i.subject })) }, endPreview(req));
      return;
    }
    if (p === 'changes' && method === 'GET') { sendJson(res, 200, await sandbox.log()); return; }
    if ((m = p.match(/^changes\/([0-9a-f]{7,40})$/)) && method === 'GET') {
      const patch = await sandbox.show(m[1]);
      if (!patch) { sendJson(res, 404, { error: 'not found' }); return; }
      send(res, 200, maskSecrets(patch), { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return;
    }
    if (p === 'role' && method === 'POST') {
      const body = await readJson(req, 4096);
      if (!mock.setRole(user, body.role)) { sendJson(res, 400, { error: 'unknown role' }); return; }
      sendJson(res, 200, { role: mock.role(user) });
      return;
    }
    if (p === 'model' && method === 'POST') {
      const body = await readJson(req, 4096);
      if (!chat.setModel(user, String(body.choice || ''))) { sendJson(res, 400, { error: 'unknown model choice' }); return; }
      sendJson(res, 200, chat.modelFor(user));
      return;
    }
    if (p === 'mock/reset' && method === 'POST') { mock.reset(); chat.log({ role: 'system', user, mode: 'edit', text: '합성 자료를 처음 상태로 되돌렸습니다.' }); broadcast({ type: 'reload', reason: 'mock-reset' }); sendJson(res, 200, { ok: true }); return; }
    if (p === 'status' && method === 'GET') { sendJson(res, 200, statusFeed.view()); return; }
    // ── 먼저 제안하기 ──
    if (p === 'suggestions' && method === 'GET') { sendJson(res, 200, suggestions.state(req)); return; }
    if (p === 'presence' && method === 'POST') {
      const body = await readJson(req, 16 * 1024);
      suggestions.presence(String(body.tab || '').slice(0, 40), user, body);
      sendJson(res, 200, suggestions.state(req));
      return;
    }
    if (p === 'suggestions/next' && method === 'POST') {
      const current = suggestions.current();
      if (current && current.status === 'ready') suggestions.answer(current.id, 'skipped', user);
      else { chat.onActivity(); suggestions.maybePrepare('asked', { asked: true }); }
      sendJson(res, 200, suggestions.state(req), endPreview(req));
      return;
    }
    if (p === 'suggestions/preview/stop' && method === 'POST') {
      const id = suggestions.previewId(req);
      if (id) suggestions.noted(id, 'preview-closed', { by: user });
      sendJson(res, 200, { ok: true }, endPreview(req) || {});
      return;
    }
    if ((m = p.match(/^suggestions\/([0-9a-f]{8})\/(seen|preview|preview-ready|answer|apply)$/)) && method === 'POST') {
      const [, id, action] = m;
      const body = await readJson(req, 16 * 1024);
      if (action === 'seen') { suggestions.noted(id, 'shown', { by: user }); sendJson(res, 200, { ok: true }); return; }
      if (action === 'preview-ready') {
        suggestions.noted(id, 'preview-ready', { by: user, clickToReadyMs: Number(body.clickToReadyMs), reloadMs: Number(body.reloadMs), readyKind: String(body.readyKind || '') });
        sendJson(res, 200, { ok: true }); return;
      }
      if (action === 'preview') {
        if (!suggestions.ready(id)) { sendJson(res, 409, { error: '이 제안은 이미 끝났습니다.' }); return; }
        suggestions.noted(id, 'previewed', { by: user });
        sendJson(res, 200, { previewing: id }, { 'Set-Cookie': suggestions.cookie(id, !!config.tls) });
        return;
      }
      touch();
      if (action === 'answer') {
        const answer = body.answer === 'skipped' ? 'skipped' : body.answer === 'declined' ? 'declined' : null;
        if (!answer) { sendJson(res, 400, { error: 'unknown answer' }); return; }
        const r = suggestions.answer(id, answer, user);
        sendJson(res, r.error ? 409 : 200, r, endPreview(req));
        return;
      }
      const r = await suggestions.apply(id, { user, displayName: session.displayName });
      sendJson(res, r.error ? 409 : 200, r, endPreview(req));
      return;
    }
    if (p === 'missing' && method === 'GET') { sendJson(res, 200, readJsonl(missingFile, 200)); return; }
    if (p === 'records' && method === 'GET') { sendJson(res, 200, readJsonl(path.join(config.paths.data, 'public', 'records.jsonl'), 300)); return; }
    if (p === 'metrics' && method === 'GET') { sendJson(res, 200, readJsonl(path.join(config.paths.data, 'metrics.jsonl'), 500)); return; }
    if (p === 'metrics/reload' && method === 'POST') {
      const body = await readJson(req, 4096);
      chat.reloadReady({ jobId: String(body.jobId || ''), reloadMs: Number(body.reloadMs), readyKind: String(body.readyKind || '') });
      sendJson(res, 200, { ok: true });
      return;
    }
    if (p === 'digest' && method === 'POST') {
      const d = await writeDigest({ dataDir: config.paths.data, sandbox, reason: 'done-for-today', by: user, activeJobs: () => chat.activeJobIds() });
      lastDigest = Date.now();
      chat.log({ role: 'system', user, displayName: session.displayName, mode: 'edit', text: `오늘 인계를 정리했습니다 (${d.day}). 지휘자가 가져갑니다.` });
      broadcast({ type: 'digest', day: d.day, reason: 'done-for-today' });
      sendJson(res, 200, { day: d.day });
      return;
    }
    if (p === 'digests' && method === 'GET') { sendJson(res, 200, listDigests(config.paths.data)); return; }
    if ((m = p.match(/^digests\/([0-9-]+)$/)) && DIGEST_ID.test(m[1]) && method === 'GET') {
      const file = path.join(config.paths.data, 'public', 'digests', `${m[1]}.md`);
      if (!fs.existsSync(file)) { sendJson(res, 404, { error: 'not found' }); return; }
      send(res, 200, fs.readFileSync(file), { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
      return;
    }
    if (p === 'logout' && method === 'POST') { auth.logout(session.sid); sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie(!!config.tls) }); return; }
    sendJson(res, 404, { error: 'unknown studio route' });
  }

  const server = config.tls
    ? https.createServer({ cert: fs.readFileSync(config.tls.cert), key: fs.readFileSync(config.tls.key) }, handler)
    : http.createServer(handler);
  server.keepAliveTimeout = 65e3;
  server.listen(config.listen.port, config.listen.host, () => {
    console.log(`minhoon studio on ${config.tls ? 'https' : 'http'}://${config.listen.host}:${config.listen.port} (sandbox ${config.paths.sandbox})`);
  });
  const stop = () => { mock.flush(); server.close(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

// A POST must come from a studio page (SameSite=Strict is the first guard; this is the second).
function sameOrigin(req, origin) {
  const o = req.headers.origin;
  return !o || o === origin;
}

main().catch(error => { console.error(error); process.exit(1); });
