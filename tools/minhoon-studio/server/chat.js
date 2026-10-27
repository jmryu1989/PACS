'use strict';
// The chat Claude: the Claude Code CLI run per request (`claude -p`, stream-json), resumed per person and day.
// 바꾸기 (edit) requests run one at a time in the sandbox: edit -> build/check -> commit -> mirror reload.
// 물어보기 (ask) requests run read-only against a detached copy of the sandbox plus the status feed.
// Confinement is the CLI's own: --restricted, dontAsk, an explicit tool list and a generated permission file
// (decision D1). Nothing here gives the model a general shell, the network or git.
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { appendJsonl, readJsonl, maskSecrets, readJsonFile, writeJsonAtomic, today } = require('./util');
const { buildAndCheck } = require('./build');

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const RECORD_RE = /<studio-record>([\s\S]*?)<\/studio-record>/g;

class Chat {
  constructor({ config, sandbox, dataDir, broadcast, statusFeed }) {
    this.config = config;
    this.sandbox = sandbox;
    this.dataDir = dataDir;
    this.broadcast = broadcast;
    this.statusFeed = statusFeed;
    this.queue = Promise.resolve();
    this.jobs = new Map();
    this.pending = 0;
    this.sessionsFile = path.join(dataDir, 'claude-sessions.json');
    this.chatFile = path.join(dataDir, 'chat.jsonl');
    this.usageFile = path.join(dataDir, 'usage.jsonl');
    this.metricsFile = path.join(dataDir, 'metrics.jsonl');
    this.recordsFile = path.join(dataDir, 'public', 'records.jsonl');
    this.writeSettings();
  }

  claudeConfigDir() {
    const account = process.env.STUDIO_CLAUDE_ACCOUNT || this.config.claude.account;
    const dir = this.config.claude.configDirs[account];
    if (!dir) throw new Error(`unknown Claude account ${account}`);
    return { account, dir };
  }

  shellCommands() {
    const py = this.config.claude.python;
    return [`${py} scripts/build-main-split-bundle.py`, `${py} scripts/build-ohif-config.py`,
      'node --check worklist-v0/hpacs-lite/main-split.bundle.js', 'node --check config/ohif.js', 'node --test studio-mock/check.test.js'];
  }

  // Generated at start so the shell tool name (Bash on the server, PowerShell on a Windows laptop) and the Python
  // command match the host. Permission rules are relative to the working directory (the sandbox).
  writeSettings() {
    const shell = this.config.claude.shellTool;
    const secretReads = ['Read(**/.env)', 'Read(**/.env.*)', 'Read(**/*.pem)', 'Read(**/*.key)', 'Read(**/credentials*.json)',
      'Read(**/*secret*)', 'Read(**/.git/**)', 'Read(**/.claude/**)'];
    const blockedTools = ['WebFetch', 'WebSearch', 'Agent', 'Task', 'NotebookEdit'];
    const edit = {
      permissions: {
        defaultMode: 'dontAsk',
        allow: ['Read', 'Grep', 'Glob', 'Edit(worklist-v0/hpacs-lite/**)', 'Edit(config/ohif/**)', 'Edit(studio-mock/**)',
          ...this.shellCommands().map(c => `${shell}(${c})`)],
        deny: ['Edit(worklist-v0/hpacs-lite/main-split.bundle.js)', 'Edit(config/ohif.js)', ...secretReads, ...blockedTools],
      },
    };
    const ask = {
      permissions: {
        defaultMode: 'dontAsk',
        allow: ['Read', 'Grep', 'Glob'],
        deny: ['Edit', 'Write', ...secretReads, ...blockedTools, `${shell}`],
      },
    };
    this.settingsDir = path.join(this.dataDir, 'claude');
    writeJsonAtomic(path.join(this.settingsDir, 'settings-edit.json'), edit);
    writeJsonAtomic(path.join(this.settingsDir, 'settings-ask.json'), ask);
    const prompt = fs.readFileSync(path.join(__dirname, '../claude/edit-system.md'), 'utf8')
      .replace('{{SHELL_COMMANDS}}', this.shellCommands().map(c => '`' + c + '`').join(', '));
    fs.writeFileSync(path.join(this.settingsDir, 'edit-system.md'), prompt);
    fs.copyFileSync(path.join(__dirname, '../claude/ask-system.md'), path.join(this.settingsDir, 'ask-system.md'));
  }

  history(limit = 300) { return readJsonl(this.chatFile, limit); }

  log(entry) {
    const item = { id: crypto.randomUUID(), t: new Date().toISOString(), ...entry };
    item.text = maskSecrets(item.text);
    appendJsonl(this.chatFile, item);
    this.broadcast({ type: 'chat', entry: item });
    return item;
  }

  status() {
    return { pending: this.pending, running: [...this.jobs.values()].filter(j => j.state === 'running').map(j => ({ id: j.id, mode: j.mode, user: j.user })) };
  }

  enqueue({ user, displayName, mode, text, context }) {
    const job = { id: crypto.randomUUID().slice(0, 8), user, displayName, mode, text, context: context || {}, state: 'queued', t: { received: Date.now() } };
    this.jobs.set(job.id, job);
    this.log({ role: 'user', user, displayName, mode, text, jobId: job.id });
    this.pending++;
    const emit = (state, extra = {}) => { job.state = state; this.broadcast({ type: 'job', id: job.id, mode, user, state, ...extra }); };
    emit('queued', { position: this.pending });
    const work = async () => {
      try {
        if (mode === 'ask') await this.runAsk(job, emit);
        else await this.runEdit(job, emit);
      } catch (error) {
        emit('failed', { error: String(error.message || error) });
        this.log({ role: 'system', mode, jobId: job.id, text: `처리 중 오류가 났습니다: ${error.message || error}` });
      } finally {
        this.pending--;
        setTimeout(() => this.jobs.delete(job.id), 3600e3);
      }
    };
    // Questions never write, so they do not wait behind edits. Edits are strictly one at a time (one writer).
    if (mode === 'ask') work();
    else this.queue = this.queue.then(work);
    return job;
  }

  sessionFor(user, mode) {
    const sessions = readJsonFile(this.sessionsFile, {});
    const key = `${today()}|${user}|${mode}`;
    return { key, id: sessions[key] || null, sessions };
  }

  rememberSession(key, id) {
    const sessions = readJsonFile(this.sessionsFile, {});
    sessions[key] = id;
    writeJsonAtomic(this.sessionsFile, sessions);
  }

  contextLines(job) {
    const c = job.context || {};
    const lines = [`[보낸 사람] ${job.displayName} (${job.user})`];
    if (c.page) lines.push(`[지금 보는 거울 화면] ${c.page}`);
    if (c.study) lines.push(`[선택된 합성 검사] ${c.study}`);
    if (c.role) lines.push(`[모의 로그인 역할] ${c.role}`);
    if (Array.isArray(c.errors) && c.errors.length) lines.push(`[거울 화면의 최근 JS 오류]\n${c.errors.slice(-5).join('\n')}`);
    if (Array.isArray(c.missing) && c.missing.length) lines.push(`[스튜디오 모의 응답이 없어 501이 난 요청]\n${c.missing.slice(-8).join('\n')}`);
    return lines.join('\n');
  }

  async runEdit(job, emit) {
    job.t.started = Date.now();
    emit('running');
    // A crash or kill in the middle of an earlier edit must not leak into this one.
    const leftovers = await this.sandbox.changes();
    if (leftovers.length) await this.sandbox.discardAll();
    const prompt = `${this.contextLines(job)}\n\n${job.text}`;
    let result = await this.claude(job, 'edit', prompt, emit);
    if (result.loginRequired) return this.finishLogin(job, emit, result);
    const blocked = await this.sandbox.discardOutside();
    let changed = (await this.sandbox.changes()).map(e => e.file);
    let check = null;
    if (changed.length) {
      emit('building');
      job.t.buildStarted = Date.now();
      check = await buildAndCheck(this.sandbox.dir, changed, { python: this.config.claude.python });
      if (!check.ok) {
        // One automatic repair turn with the exact error, then give up and keep the last good screen.
        emit('repairing', { errors: check.errors.map(maskSecrets) });
        const repair = await this.claude(job, 'edit', `[스튜디오 자동 검사] 방금 고친 내용이 빌드/문법 검사에서 실패했습니다. 고쳐 주세요. 설명은 한 줄로.\n${check.errors.join('\n').slice(0, 6000)}`, emit);
        result = mergeResults(result, repair);
        await this.sandbox.discardOutside();
        changed = (await this.sandbox.changes()).map(e => e.file);
        check = changed.length ? await buildAndCheck(this.sandbox.dir, changed, { python: this.config.claude.python }) : check;
      }
      job.t.buildDone = Date.now();
    }
    const { text, records } = splitRecords(result.text);
    this.saveRecords(job, records);
    this.recordUsage(job, 'edit', result);
    if (changed.length && check && !check.ok) {
      await this.sandbox.discardAll();
      this.log({ role: 'assistant', mode: 'edit', jobId: job.id, text: `${text}\n\n(자동 검사에서 계속 실패해서 이번 변경은 적용하지 않았습니다. 화면은 그대로입니다.)`, meta: { failed: true, errors: check.errors.slice(0, 5).map(maskSecrets) } });
      emit('failed', { error: 'check', errors: check.errors.slice(0, 5).map(maskSecrets) });
      this.metric(job, { ok: false, reason: 'check-failed', result });
      return;
    }
    if (!changed.length) {
      this.log({ role: 'assistant', mode: 'edit', jobId: job.id, text, meta: { changed: false, blocked, records: records.map(r => r.kind) } });
      emit('done', { changed: false });
      this.metric(job, { ok: true, changed: false, result });
      return;
    }
    const commit = await this.sandbox.commit({
      subject: job.text.split('\n')[0] || '(빈 요청)',
      body: `${job.text}\n\n--- Claude ---\n${text}`.slice(0, 6000),
      trailers: { 'Studio-Kind': 'change', 'Studio-User': job.user, 'Studio-Request': job.id, 'Studio-Model': result.model || 'default' },
    });
    job.t.committed = Date.now();
    this.log({ role: 'assistant', mode: 'edit', jobId: job.id, text, meta: { changed: true, sha: commit.sha, files: commit.files, blocked, steps: check && check.steps, records: records.map(r => r.kind) } });
    job.t.reloadSent = Date.now();
    emit('applied', { sha: commit.sha, files: commit.files, timings: this.timings(job, result) });
    this.broadcast({ type: 'reload', reason: 'edit', jobId: job.id, sha: commit.sha });
    this.metric(job, { ok: true, changed: true, sha: commit.sha, files: commit.files, result });
  }

  async runAsk(job, emit) {
    job.t.started = Date.now();
    emit('running');
    const prompt = `${this.contextLines(job)}\n\n[현황 요약 — status.json]\n${this.statusFeed.summary()}\n\n[질문]\n${job.text}`;
    const result = await this.claude(job, 'ask', prompt, emit);
    if (result.loginRequired) return this.finishLogin(job, emit, result);
    const { text, records } = splitRecords(result.text);
    this.saveRecords(job, records);
    this.recordUsage(job, 'ask', result);
    this.log({ role: 'assistant', mode: 'ask', jobId: job.id, text, meta: { records: records.map(r => r.kind) } });
    emit('done', { changed: false, timings: this.timings(job, result) });
  }

  finishLogin(job, emit, result) {
    const text = 'Claude 로그인이 아직 안 되어 있어서 답할 수 없습니다. 정모 님이 서버에서 한 번 로그인하면 바로 쓸 수 있습니다(README의 "Claude 로그인").';
    this.log({ role: 'system', mode: job.mode, jobId: job.id, text, meta: { loginRequired: true, detail: maskSecrets(result.error || '') } });
    emit('failed', { error: 'login-required' });
  }

  // One CLI turn. Streams progress to the browsers and returns the parsed result with timestamps.
  claude(job, mode, prompt, emit) {
    const { account, dir } = this.claudeConfigDir();
    const session = this.sessionFor(job.user, mode);
    const cwd = mode === 'ask' ? this.sandbox.readDir : this.sandbox.dir;
    const shell = this.config.claude.shellTool;
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--restricted', '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
      '--tools', mode === 'ask' ? 'Read,Grep,Glob' : `Read,Grep,Glob,Edit,Write,${shell}`,
      '--settings', path.join(this.settingsDir, `settings-${mode}.json`),
      '--append-system-prompt-file', path.join(this.settingsDir, `${mode}-system.md`)];
    if (mode === 'ask') {
      args.push('--add-dir', this.statusFeed.dir, path.join(this.dataDir, 'public'));
    }
    const model = mode === 'ask' ? (this.config.claude.askModel || this.config.claude.model) : this.config.claude.model;
    if (model) args.push('--model', model);
    const effort = mode === 'ask' ? this.config.claude.askEffort : this.config.claude.effort;
    if (effort) args.push('--effort', effort);
    let sessionId = session.id;
    if (sessionId) args.push('--resume', sessionId);
    else { sessionId = crypto.randomUUID(); args.push('--session-id', sessionId); }

    const env = { ...process.env, CLAUDE_CONFIG_DIR: dir, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
    delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN; delete env.CLAUDE_CODE_OAUTH_TOKEN;
    if (this.config.claude.pathPrepend) env.PATH = this.config.claude.pathPrepend + path.delimiter + (env.PATH || '');

    return new Promise(resolve => {
      const started = Date.now();
      const out = { text: '', model: null, sessionId, account, t: { spawn: started }, edits: [], tools: [], denials: [], usage: null, costUsd: null };
      let child;
      try {
        child = spawn(this.config.claude.bin, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (error) {
        resolve({ ...out, error: String(error.message), loginRequired: false });
        return;
      }
      const pendingEdits = new Map();
      let buffer = '', stderr = '', partial = '';
      const timer = setTimeout(() => { out.timedOut = true; child.kill(); }, (this.config.claude.turnTimeoutSec || 900) * 1000);
      child.stdout.on('data', chunk => {
        buffer += chunk.toString('utf8');
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim(); buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let ev; try { ev = JSON.parse(line); } catch { continue; }
          if (!out.t.first && ev.type !== 'system') out.t.first = Date.now();
          if (ev.type === 'system' && ev.subtype === 'init') { out.model = ev.model; out.sessionId = ev.session_id || sessionId; }
          else if (ev.type === 'stream_event') {
            const d = ev.event && ev.event.delta;
            if (d && d.type === 'text_delta' && d.text) {
              partial += d.text;
              emit('delta', { text: maskSecrets(visiblePart(partial)) });
            }
          } else if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
            for (const item of ev.message.content) {
              if (item.type === 'tool_use') {
                const summary = toolSummary(item.name, item.input || {}, cwd);
                out.tools.push({ name: item.name, summary, t: Date.now() });
                if (EDIT_TOOLS.has(item.name)) pendingEdits.set(item.id, summary);
                emit('tool', { name: item.name, summary: maskSecrets(summary) });
              } else if (item.type === 'text') { partial = ''; }
            }
          } else if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
            for (const item of ev.message.content) {
              if (item.type === 'tool_result' && pendingEdits.has(item.tool_use_id)) {
                if (!item.is_error) { out.edits.push(pendingEdits.get(item.tool_use_id)); out.t.lastEdit = Date.now(); }
                pendingEdits.delete(item.tool_use_id);
              }
            }
          } else if (ev.type === 'result') {
            out.text = typeof ev.result === 'string' ? ev.result : '';
            out.isError = !!ev.is_error;
            out.subtype = ev.subtype;
            out.usage = ev.usage || null;
            out.modelUsage = ev.modelUsage || null;
            out.costUsd = typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : null;
            out.durationMs = ev.duration_ms; out.durationApiMs = ev.duration_api_ms; out.numTurns = ev.num_turns;
            out.denials = (ev.permission_denials || []).map(d => ({ tool: d.tool_name, target: toolSummary(d.tool_name, d.tool_input || {}, cwd) }));
            out.sessionId = ev.session_id || out.sessionId;
          }
        }
      });
      child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); if (stderr.length > 20000) stderr = stderr.slice(-20000); });
      child.on('error', error => { stderr += String(error.message); });
      child.on('close', code => {
        clearTimeout(timer);
        out.t.done = Date.now();
        out.exitCode = code;
        const failure = `${out.isError ? out.text : ''}\n${stderr}`;
        out.loginRequired = /log ?in|\/login|not logged|invalid api key|authenticat|oauth|credential/i.test(failure) && (!out.text || out.isError);
        if (!out.text && !out.loginRequired) {
          out.text = out.timedOut ? '시간 안에 끝나지 않아 멈췄습니다. 요청을 조금 나눠서 다시 말씀해 주세요.'
            : `Claude 실행이 실패했습니다 (exit ${code}). ${maskSecrets(stderr.trim().split('\n').slice(-3).join(' '))}`;
        }
        out.error = out.loginRequired ? failure.slice(-500) : null;
        if (out.sessionId && !out.loginRequired && code === 0) this.rememberSession(session.key, out.sessionId);
        else if (session.id && code !== 0 && /session|resume|conversation/i.test(stderr)) {
          // A lost or broken session: forget it so the next request starts fresh instead of failing again.
          this.rememberSession(session.key, null);
        }
        resolve(out);
      });
      child.stdin.end(prompt);
    });
  }

  saveRecords(job, records) {
    for (const record of records) {
      appendJsonl(this.recordsFile, { t: new Date().toISOString(), jobId: job.id, user: job.user, mode: job.mode, request: job.text, ...record });
    }
    if (records.length) this.broadcast({ type: 'records', jobId: job.id, kinds: records.map(r => r.kind) });
  }

  recordUsage(job, mode, result) {
    appendJsonl(this.usageFile, {
      t: new Date().toISOString(), jobId: job.id, user: job.user, mode, model: result.model, account: result.account,
      usage: result.usage, modelUsage: result.modelUsage, costUsdReported: result.costUsd,
      durationMs: result.durationMs, durationApiMs: result.durationApiMs, numTurns: result.numTurns,
      tools: result.tools.length, edits: result.edits.length, denials: result.denials,
    });
  }

  timings(job, result) {
    const t = job.t, r = result.t || {};
    return {
      queuedMs: t.started - t.received,
      claudeMs: (r.done || t.started) - t.started,
      firstEventMs: r.first ? r.first - r.spawn : null,
      buildMs: t.buildDone && t.buildStarted ? t.buildDone - t.buildStarted : 0,
      commitMs: t.committed && t.buildDone ? t.committed - t.buildDone : t.committed && r.done ? t.committed - r.done : null,
      lastEditToReloadSentMs: r.lastEdit && t.reloadSent ? t.reloadSent - r.lastEdit : null,
      claudeDoneToReloadSentMs: r.done && t.reloadSent ? t.reloadSent - r.done : null,
      totalToReloadSentMs: t.reloadSent ? t.reloadSent - t.received : null,
    };
  }

  metric(job, { ok, changed, sha, files, reason, result }) {
    appendJsonl(this.metricsFile, {
      t: new Date().toISOString(), jobId: job.id, user: job.user, ok, changed: !!changed, reason, sha, files,
      model: result.model, text: job.text.slice(0, 200), timings: this.timings(job, result),
      tools: result.tools.length, edits: result.edits.length, numTurns: result.numTurns,
    });
  }

  // The browser reports when the mirror finished reloading (it measures with its own clock: reload event -> ready).
  reloadReady({ jobId, reloadMs, readyKind }) {
    appendJsonl(this.metricsFile, { t: new Date().toISOString(), jobId, reloadMs, readyKind, kind: 'reload-ready' });
  }
}

function mergeResults(a, b) {
  return {
    ...b, text: b.text || a.text, edits: [...a.edits, ...b.edits], tools: [...a.tools, ...b.tools], denials: [...a.denials, ...b.denials],
    costUsd: (a.costUsd || 0) + (b.costUsd || 0), t: { ...a.t, done: b.t.done, lastEdit: b.t.lastEdit || a.t.lastEdit },
    numTurns: (a.numTurns || 0) + (b.numTurns || 0),
  };
}

// While streaming, hide a record block that has started but not finished.
function visiblePart(text) {
  const cut = text.indexOf('<studio-record>');
  return cut >= 0 ? text.slice(0, cut) : text.replace(/<studio-rec?o?r?d?>?$/, '');
}

function splitRecords(text) {
  const records = [];
  const clean = String(text || '').replace(RECORD_RE, (_, body) => {
    try { const value = JSON.parse(body.trim()); if (value && typeof value === 'object') records.push(value); } catch { records.push({ kind: 'unparsed', raw: body.trim().slice(0, 2000) }); }
    return '';
  }).trim();
  return { text: maskSecrets(clean), records };
}

function toolSummary(name, input, cwd) {
  const rel = p => (typeof p === 'string' ? path.relative(cwd, path.resolve(cwd, p)).replace(/\\/g, '/') : '');
  switch (name) {
    case 'Read': return `읽기 ${rel(input.file_path)}`;
    case 'Edit': case 'MultiEdit': return `수정 ${rel(input.file_path)}`;
    case 'Write': return `쓰기 ${rel(input.file_path)}`;
    case 'Grep': return `찾기 "${String(input.pattern || '').slice(0, 60)}"${input.path ? ' in ' + rel(input.path) : ''}`;
    case 'Glob': return `파일 찾기 ${String(input.pattern || '').slice(0, 60)}`;
    case 'Bash': case 'PowerShell': return `실행 ${String(input.command || '').slice(0, 100)}`;
    default: return name;
  }
}

module.exports = { Chat, splitRecords, toolSummary, visiblePart };
