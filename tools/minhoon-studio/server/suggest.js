'use strict';
// 먼저 제안하기 (decision D5 and the owner's addition: the studio recommends better improvements on its own, and
// criticises). While nobody is typing and no change is running, the studio Claude picks ONE grounded improvement for
// the screen he is on, builds it in a separate preview copy of the sandbox and commits it to a preview ref. The card
// "제안: …" offers 미리보기 (this browser's product window is served from the preview copy: one reload), 적용 (the
// change lands on the studio branch like any edit and can be undone), 다른 제안 and 됐어요. Answered suggestions are
// remembered and not offered again; every suggestion and its answer go into the daily digest.
// No frequency cap (D5: measure, then tune): one suggestion is open at a time and the next one is prepared only after
// it is answered, so a studio left open overnight prepares one and waits.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { appendJsonl, readJsonl, readJsonFile, writeJsonAtomic, maskSecrets, parseCookies } = require('./util');
const { buildAndCheck } = require('./build');
const { Sandbox } = require('./sandbox');
const { turnFailed } = require('./chat');

// The preview copy holds front-end changes only: the mock API reads the main sandbox, so it could not show a mock change.
const PREVIEW_PATHS = ['worklist-v0/hpacs-lite/', 'config/ohif/', 'config/ohif.js'];
const SOURCE_PATHS = ['worklist-v0/hpacs-lite/', 'config/ohif/'];
const BLOCK_RE = /<studio-suggestion>([\s\S]*?)<\/studio-suggestion>/g;
const GROUND_KINDS = new Set(['screen', 'feedback', 'practice']);
const OPEN = new Set(['preparing', 'ready']);
const ANSWERED = new Set(['applied', 'declined', 'skipped']);
const COOKIE = 'mstudio_preview';
const norm = s => String(s == null ? '' : s).replace(/[*_`>#]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const oneLine = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

// The last <studio-suggestion> block of a turn, checked: a title, a request and at least one ground that holds up.
// Feedback grounds must name an existing item and quote it as written; a screen ground that names a file must name
// one that exists. A suggestion whose grounds all fail is not offered (it would be an unsupported claim).
function parseSuggestion(text, { feedback = '', fileExists = () => true } = {}) {
  const blocks = [...String(text || '').matchAll(BLOCK_RE)];
  if (!blocks.length) return { error: 'no-block' };
  let value;
  try { value = JSON.parse(blocks[blocks.length - 1][1].trim()); } catch { return { error: 'unparsed' }; }
  if (!value || typeof value !== 'object') return { error: 'unparsed' };
  if (value.none === true) return { none: true, why: oneLine(value.why, 400) };
  const title = oneLine(value.title, 120), request = String(value.request || '').trim().slice(0, 2000);
  if (!title || !request) return { error: 'incomplete' };
  const items = feedbackItems(feedback);
  const plain = norm(feedback);
  const grounds = [], dropped = [];
  for (const g of Array.isArray(value.grounds) ? value.grounds.slice(0, 6) : []) {
    const kind = g && String(g.kind || '');
    const ref = oneLine(g && g.ref, 200), quote = oneLine(g && g.quote, 300);
    let ok = GROUND_KINDS.has(kind) && !!ref;
    if (ok && kind === 'feedback') {
      const n = Number((ref.match(/\d+/) || [])[0]);
      ok = items.has(n) && (!quote || plain.includes(norm(quote)));
    } else if (ok && kind === 'screen') {
      const file = ref.match(/^([\w./-]+\.(?:js|html|css|json))(?::\d+)?/);
      ok = !file || fileExists(file[1]);
    }
    (ok ? grounds : dropped).push({ kind, ref, quote });
  }
  if (!grounds.length) return { error: 'ungrounded', dropped };
  const key = String(value.key || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
    || crypto.createHash('sha1').update(norm(title)).digest('hex').slice(0, 12);
  return { suggestion: { key, kind: value.kind === 'critique' ? 'critique' : 'improve', title, why: oneLine(value.why, 600), grounds, dropped, request } };
}

// Numbered items of the feedback file ("1. **MG loading …**", "10. **Worklist columns.**").
function feedbackItems(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/^\s*(\d{1,3})\.\s/gm)) out.add(Number(m[1]));
  return out;
}

class Suggestions {
  constructor({ config, sandbox, chat, dataDir, statusFeed, broadcast, previewDir, feedbackFile }) {
    this.config = config;
    this.sandbox = sandbox;
    this.chat = chat;
    this.statusFeed = statusFeed;
    this.broadcast = broadcast;
    this.previewDir = previewDir;
    this.feedbackFile = feedbackFile;
    this.preview = new Sandbox({ dir: previewDir, allowedPaths: PREVIEW_PATHS });
    this.file = path.join(dataDir, 'suggestions.json');
    this.eventsFile = path.join(dataDir, 'public', 'suggestions.jsonl');
    this.enabled = !(config.suggest && config.suggest.enabled === false);
    this.tabs = new Map(); // studio chat tab -> { user, typing, page, study, role, at }
    this.lock = Promise.resolve();
    this.preparing = null;
    this.previewHead = null; // the preview copy's checked-out commit when it holds a finished preview
    this.waitForActivity = false; // after a prepare that produced nothing: the next request or answer lifts it
    chat.dirs.suggest = previewDir;
    chat.onActivity = () => { this.waitForActivity = false; };
    chat.onSettled = job => { if (job.mode === 'edit') this.followHead().catch(e => console.error('suggestion rebase failed', e)); this.maybePrepare('settled'); };
  }

  async init() {
    await this.sandbox.worktree(this.previewDir);
    const items = this.items();
    // A prepare cut off by a restart never finished; a ready one is kept only if its preview commit still exists.
    for (const item of items.filter(i => OPEN.has(i.status))) {
      if (item.status === 'preparing') this.close(item, 'interrupted');
      else if (!(await this.checkoutPreview(item.previewSha))) this.close(item, 'stale');
    }
    this.save(items);
  }

  items() { return readJsonFile(this.file, { items: [] }).items; }
  save(items) { writeJsonAtomic(this.file, { items: items.slice(-300) }); }
  current() { return this.items().find(i => OPEN.has(i.status)) || null; }
  // Read, change and write one suggestion with no await in between: an answer given while a preview was being
  // rebuilt must not be overwritten by a list read before it (seen in the real-browser run of this change).
  // fn returns false to leave the file as it is.
  mutate(id, fn) {
    const items = this.items();
    const item = items.find(i => i.id === id);
    if (!item || fn(item) === false) return null;
    this.save(items);
    return item;
  }
  close(item, status, extra = {}) { Object.assign(item, { status, closedAt: new Date().toISOString(), ...extra }); this.event(item, status, extra); }
  event(item, event, extra = {}) {
    appendJsonl(this.eventsFile, { t: new Date().toISOString(), id: item.id, event, title: item.title || null, ...extra });
  }

  // What a browser may see: no folders, no internal state.
  view(item) {
    if (!item) return null;
    return { id: item.id, status: item.status, kind: item.kind || null, title: item.title || null, why: item.why || null,
      grounds: item.grounds || [], request: item.request || null, files: (item.files || []).filter(f => !/bundle\.js$|config\/ohif\.js$/.test(f)),
      prepareMs: item.prepareMs ?? null, asked: !!item.asked, reason: item.reason || null, error: item.error || null };
  }

  // ── who is here and typing (each chat tab reports; a tab that closes its event stream is gone) ──
  presence(tab, user, info = {}) {
    if (!tab) return;
    const was = this.typing();
    this.tabs.set(tab, { user, typing: !!info.typing, page: oneLine(info.page, 300), study: oneLine(info.study, 300), role: oneLine(info.role, 30), at: Date.now() });
    if (was && !this.typing()) this.maybePrepare('typing-stopped');
    else this.maybePrepare('presence');
  }
  dropTab(tab) { this.tabs.delete(tab); }
  typing() { return [...this.tabs.values()].some(t => t.typing); }
  latestTab() { return [...this.tabs.values()].sort((a, b) => b.at - a.at)[0] || null; }

  // Prepare the next suggestion when nobody is typing, no request is queued or running, someone has the studio open
  // and nothing is already open. Returns whether a prepare started.
  maybePrepare(reason, { asked = false } = {}) {
    if (!this.enabled || this.preparing || this.current()) return false;
    if (this.chat.pending > 0 || !this.tabs.size || this.typing()) return false;
    if (this.waitForActivity && !asked) return false;
    this.preparing = this.prepare(reason, asked).catch(error => console.error('suggestion prepare failed', error)).finally(() => { this.preparing = null; });
    return true;
  }

  // The writer queue's patience is not needed here: the preview copy is its own working tree. Only preview-copy
  // operations (prepare, rebase) are serialised with each other.
  underLock(fn) {
    const run = this.lock.then(fn);
    this.lock = run.catch(() => {});
    return run;
  }

  async checkoutPreview(sha) {
    this.previewHead = null;
    if (!sha) return false;
    const r = await this.preview.git(['checkout', '--detach', '--force', sha]);
    if (r.code) return false;
    await this.preview.discardAll();
    this.previewHead = sha;
    return true;
  }

  model() {
    const s = this.config.suggest || {};
    const models = this.config.claude.models || {};
    return s.model || models.deep || this.config.claude.model || null;
  }

  feedbackText() {
    try { return fs.readFileSync(this.feedbackFile, 'utf8'); } catch { return ''; }
  }

  async prepare(reason, asked) {
    const tab = this.latestTab() || {};
    const items = this.items();
    const item = { id: crypto.randomUUID().slice(0, 8), t: new Date().toISOString(), status: 'preparing', reason, asked, forUser: tab.user || null, model: this.model() };
    items.push(item); this.save(items);
    this.broadcast({ type: 'suggestion', item: this.view(item) });
    const started = Date.now();
    const result = await this.underLock(async () => {
      const head = await this.sandbox.publishedHead();
      if (!(await this.checkoutPreview(head))) return { error: 'preview-checkout' };
      this.previewHead = null; // being edited: not a preview anyone may be served until it is committed
      const job = { id: `s-${item.id}`, user: tab.user || 'studio', mode: 'suggest', model: item.model, text: '(먼저 제안하기)', t: {} };
      const claudeStarted = Date.now();
      const out = await this.chat.claude(job, 'suggest', this.prompt(tab, items), () => {});
      this.chat.recordUsage(job, 'suggest', out);
      const claudeMs = Date.now() - claudeStarted;
      if (out.loginRequired) { await this.preview.discardAll(); return { error: 'login-required', claudeMs }; }
      if (turnFailed(out)) { await this.preview.discardAll(); return { error: out.timedOut ? 'claude-timeout' : 'claude-failed', claudeMs }; }
      const feedback = this.feedbackText();
      const parsed = parseSuggestion(out.text, { feedback, fileExists: f => fs.existsSync(path.join(this.previewDir, f)) });
      if (parsed.none) { await this.preview.discardAll(); return { none: true, why: parsed.why, claudeMs }; }
      if (parsed.error) { await this.preview.discardAll(); return { error: parsed.error, dropped: parsed.dropped, claudeMs }; }
      const s = parsed.suggestion;
      if (this.repeats(s, items)) { await this.preview.discardAll(); return { error: 'repeat', title: s.title, claudeMs }; }
      await this.preview.discardOutside();
      const changed = (await this.preview.changes()).map(e => e.file);
      if (!changed.length) return { error: 'no-change', suggestion: s, claudeMs };
      const buildStarted = Date.now();
      const check = await buildAndCheck(this.previewDir, changed, { python: this.config.claude.python });
      if (!check.ok) { await this.preview.discardAll(); return { error: 'check-failed', errors: check.errors.slice(0, 3).map(maskSecrets), suggestion: s, claudeMs }; }
      const commit = await this.preview.commit({ subject: `제안: ${s.title}`, body: `${s.why}\n\n${s.request}`,
        trailers: { 'Studio-Kind': 'suggestion', 'Studio-Suggestion': item.id, 'Studio-Model': out.model || 'default' } });
      // A named ref keeps the preview reachable after the copy moves on (the commander can fetch it with the branch).
      await this.preview.ok(['update-ref', `refs/studio-preview/${item.id}`, commit.sha]);
      this.previewHead = commit.sha;
      return { suggestion: s, baseSha: head, previewSha: commit.sha, files: commit.files, claudeMs, buildMs: Date.now() - buildStarted, model: out.model };
    });
    const prepareMs = Date.now() - started;
    if (result.suggestion && result.previewSha) {
      const stored = this.mutate(item.id, s => {
        Object.assign(s, result.suggestion, { status: 'ready', baseSha: result.baseSha, previewSha: result.previewSha, files: result.files,
          prepareMs, claudeMs: result.claudeMs, buildMs: result.buildMs, model: result.model || s.model, readyAt: new Date().toISOString() });
      });
      this.event(stored, 'prepared', { key: stored.key, kind: stored.kind, why: stored.why, grounds: stored.grounds, request: stored.request,
        dropped: stored.dropped, files: stored.files, prepareMs, claudeMs: result.claudeMs, buildMs: result.buildMs, reason, asked, model: stored.model });
      this.broadcast({ type: 'suggestion', item: this.view(stored) });
      // A change applied while this one was being built moved the screen on: bring the preview up to it. Not awaited:
      // an answer given meanwhile must be able to start the next suggestion (it queues behind this on the lock).
      this.followHead().catch(e => console.error('suggestion rebase failed', e));
      return;
    }
    // Nothing to offer: wait for his next request or answer before trying again (no retry loop on a failing turn).
    this.waitForActivity = true;
    const stored = this.mutate(item.id, s => {
      if (result.suggestion) Object.assign(s, { title: result.suggestion.title, key: result.suggestion.key, grounds: result.suggestion.grounds });
      this.close(s, result.none ? 'none' : 'failed', { error: result.error || null, why: result.why || null, errors: result.errors || null,
        dropped: result.dropped || null, prepareMs, claudeMs: result.claudeMs ?? null, reason, asked });
    });
    this.broadcast({ type: 'suggestion', item: this.view(stored) });
  }

  // What he has answered, or seen before the screen moved on, is not offered again (same key or same title). A
  // suggestion that failed to build was never in front of him, so the idea stays available.
  remembered(items) {
    return items.filter(i => i.title && (ANSWERED.has(i.status) || (i.status === 'stale' && i.seenAt)));
  }
  repeats(s, items) {
    return this.remembered(items).some(i => i.key === s.key || norm(i.title) === norm(s.title));
  }

  prompt(tab, items) {
    const history = this.chat.history(400);
    const answers = new Map();
    for (const e of history) if (e.jobId && e.role !== 'user') answers.set(e.jobId, e.meta || {});
    const asked = history.filter(e => e.role === 'user').slice(-12).map(e => {
      const meta = answers.get(e.jobId);
      const outcome = !meta ? '진행 중' : meta.failed ? '실패' : meta.changed ? '적용됨' : e.mode === 'ask' ? '답함' : '바꾸지 않음';
      return `- ${e.t.slice(11, 16)}Z ${e.displayName || e.user} (${e.mode === 'ask' ? '물어보기' : '바꾸기'}, ${outcome}) ${oneLine(e.text, 300)}`;
    });
    const done = this.remembered(items).slice(-40)
      .map(i => `- [${i.key}] ${i.title} — ${{ applied: '적용함', declined: '됐어요(거절)', skipped: '다른 제안으로 넘김', stale: '보여 줬지만 화면이 바뀌어 버림' }[i.status] || i.status}`);
    const feedback = this.feedbackText();
    return [
      '[스튜디오 먼저 제안하기 — 선생님의 요청이 아님. 개선안 하나를 골라 이 미리보기 사본에서 만든다]',
      '[이 사본은 지금 스튜디오 화면 그대로다. 앞선 제안 턴에서 고친 것은 이 사본에 없다(적용된 것은 이미 화면에 들어 있다).]',
      `[지금 제품 화면] ${tab.page || '(모름)'}${tab.role ? ` · 역할 ${tab.role}` : ''}${tab.study ? `\n[선택된 합성 검사] ${tab.study}` : ''}`,
      `[최근 요청 (오래된 것부터)]\n${asked.join('\n') || '(아직 없음)'}`,
      `[민훈 선생님 피드백 — ${path.basename(this.feedbackFile || 'feedback.md')}, 추가 읽기 폴더에도 있음]\n${feedback ? feedback.slice(0, 20000) : '(피드백 파일 없음)'}`,
      `[이미 한 제안 — 다시 내지 않음]\n${done.join('\n') || '(없음)'}`,
      `[현황 요약 — status.json]\n${this.statusFeed.summary()}`,
    ].join('\n\n');
  }

  // The front-end source diff of a preview (generated files are rebuilt where it lands).
  async sourcePatch(item, repo = this.sandbox) {
    const order = readJsonFile(path.join(repo.dir, 'scripts/main-split-order.json'), {});
    const exclude = [order.artifact, 'config/ohif.js'].filter(Boolean).map(f => `:(exclude)${f}`);
    return repo.ok(['diff', '--binary', item.baseSha, item.previewSha, '--', ...SOURCE_PATHS, ...exclude]);
  }

  // Apply a source patch to a working tree, rebuild and check it. Returns the changed files or null (tree put back).
  async land(repo, patch) {
    if (!patch.trim()) return null;
    const r = await repo.git(['apply', '--3way', '--whitespace=nowarn', '-'], { input: patch });
    if (r.code) { await repo.discardAll(); return null; }
    await repo.discardOutside();
    const changed = (await repo.changes()).map(e => e.file);
    if (!changed.length) return null;
    const check = await buildAndCheck(repo.dir, changed, { python: this.config.claude.python });
    if (!check.ok) { await repo.discardAll(); return null; }
    return changed;
  }

  // The screen moved on (an edit or an undo) while a suggestion is ready: rebuild its preview on the new screen, or
  // set it aside if it no longer fits (it may then be suggested again).
  async followHead() {
    const item = this.current();
    if (!item || item.status !== 'ready') return;
    const head = await this.sandbox.publishedHead();
    if (head === item.baseSha) return;
    await this.underLock(async () => {
      const now = this.current();
      if (!now || now.id !== item.id || now.status !== 'ready') return;
      const patch = await this.sourcePatch(now);
      let ok = await this.checkoutPreview(head);
      this.previewHead = null; // the new screen without the suggestion is not its preview
      if (ok) ok = !!(await this.land(this.preview, patch));
      let commit = null;
      if (ok) {
        commit = await this.preview.commit({ subject: `제안: ${now.title}`, body: `${now.why}\n\n${now.request}`,
          trailers: { 'Studio-Kind': 'suggestion', 'Studio-Suggestion': now.id, 'Studio-Rebased-From': now.previewSha } });
        await this.preview.ok(['update-ref', `refs/studio-preview/${now.id}`, commit.sha]);
      }
      // He may have answered while this ran: an answered suggestion stays answered.
      const stored = this.mutate(item.id, s => {
        if (s.status !== 'ready') return false;
        if (commit) Object.assign(s, { baseSha: head, previewSha: commit.sha, files: commit.files });
        else this.close(s, 'stale', { reason: 'screen-changed' });
      });
      if (!stored) return;
      if (commit) {
        this.previewHead = commit.sha;
        this.event(stored, 'rebased', { baseSha: head });
        this.broadcast({ type: 'suggestion', item: this.view(stored), rebased: true });
      } else {
        this.broadcast({ type: 'suggestion', item: this.view(stored) });
        this.maybePrepare('stale');
      }
    });
  }

  // ── answers ──
  ready(id) {
    const item = this.current();
    return item && item.id === id && item.status === 'ready' ? item : null;
  }

  answer(id, answer, user) {
    const item = this.mutate(id, s => (s.status === 'ready' ? this.close(s, answer, { by: user, answer }) : false));
    if (!item) return { error: '이 제안은 이미 끝났습니다.' };
    this.broadcast({ type: 'suggestion', item: this.view(item) });
    this.waitForActivity = false;
    // 다른 제안 asks for the next one now; 됐어요 lets the next one come when he is idle again.
    this.maybePrepare(answer === 'skipped' ? 'next' : 'answered', { asked: answer === 'skipped' });
    return { ok: true };
  }

  // Card shown, preview opened/closed, preview on screen: recorded for the digest (D5: measure, then tune).
  noted(id, event, extra = {}) {
    const items = this.items();
    const item = items.find(i => i.id === id);
    if (!item) return false;
    const field = { shown: 'seenAt', previewed: 'previewedAt' }[event];
    if (field && !item[field]) { item[field] = new Date().toISOString(); this.save(items); }
    this.event(item, event, extra);
    return true;
  }

  // 적용: the preview's source change lands on the studio branch through the writer queue, rebuilt and checked like
  // an edit; it is then an ordinary change (기록, 되돌리기). If it no longer applies to the screen as it is now, the
  // studio Claude builds the same request there as an ordinary edit.
  apply(id, { user, displayName }) {
    const run = this.chat.queue.then(() => this.applyNow(id, { user, displayName }));
    this.chat.queue = run.catch(() => {});
    return run;
  }

  async applyNow(id, { user, displayName }) {
    const item = this.ready(id);
    if (!item) return { error: '이 제안은 이미 끝났습니다.' };
    const started = Date.now();
    if ((await this.sandbox.changes()).length) await this.sandbox.discardAll();
    const changed = await this.land(this.sandbox, await this.sourcePatch(item));
    // Applied is what happened, whatever answer arrived while it ran (the change is on the branch).
    const finish = extra => this.mutate(id, s => { if (s.status === 'ready') this.close(s, 'applied', { by: user, answer: 'applied', ...extra }); else this.event(s, 'applied', { by: user, ...extra }); });
    if (!changed) {
      const stored = finish({ via: 'edit' });
      this.broadcast({ type: 'suggestion', item: this.view(stored) });
      const job = this.chat.enqueue({ user, displayName, mode: 'edit', text: `[제안 적용] ${item.title}\n${item.request}`, context: { suggestion: id } });
      return { via: 'edit', jobId: job.id };
    }
    const jobId = `s-${id}`;
    const commit = await this.sandbox.commit({
      subject: `제안: ${item.title}`,
      body: `${item.why}\n\n요청: ${item.request}\n\n근거:\n${item.grounds.map(g => `- ${g.kind} ${g.ref}${g.quote ? ` "${g.quote}"` : ''}`).join('\n')}`,
      trailers: { 'Studio-Kind': 'change', 'Studio-User': user, 'Studio-Request': jobId, 'Studio-Suggestion': id, 'Studio-Model': item.model || 'default' },
    });
    const stored = finish({ via: 'preview', sha: commit.sha, applyMs: Date.now() - started });
    this.broadcast({ type: 'suggestion', item: this.view(stored) });
    this.chat.log({ role: 'user', user, displayName, mode: 'edit', text: `제안 적용: ${stored.title}`, jobId, meta: { suggestion: id } });
    this.chat.log({ role: 'assistant', mode: 'edit', jobId, text: `${stored.why}\n(미리 만들어 둔 제안을 그대로 적용했습니다. 되돌리기로 언제든 뺄 수 있습니다.)`,
      meta: { changed: true, sha: commit.sha, files: commit.files, suggestion: id } });
    this.broadcast({ type: 'reload', reason: 'edit', jobId, sha: commit.sha });
    this.waitForActivity = false;
    this.maybePrepare('applied');
    return { via: 'preview', sha: commit.sha };
  }

  // ── the preview in a browser: a cookie names the suggestion; the mirror serves the preview copy for it ──
  previewId(req) { return parseCookies(req.headers.cookie)[COOKIE] || null; }
  previewRoot(req) {
    const id = this.previewId(req);
    if (!id) return null;
    const item = this.ready(id);
    return item && this.previewHead && this.previewHead === item.previewSha ? this.previewDir : null;
  }
  previewing(req) { const id = this.previewId(req); return id && this.ready(id) ? id : null; }
  cookie(id, secure) { return `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`; }
  clearCookie(secure) { return `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`; }

  state(req) {
    const item = this.current();
    return { current: this.view(item), previewing: req ? this.previewing(req) : null, enabled: this.enabled };
  }
}

module.exports = { Suggestions, parseSuggestion, feedbackItems, PREVIEW_PATHS, COOKIE };
