'use strict';
// The sandbox is a plain git repository holding a snapshot of the product at a fixed main SHA (tag studio-base).
// Every applied change is one commit on the studio branch and "되돌리기" is `git revert` (decision D2): no new
// snapshot format, and the commander collects the branch as ordinary commits. This branch is not product history.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

// Where a chat edit may land. Anything else that changes is put back and reported (it should already be impossible
// through the Claude permission rules; this is the second line).
const ALLOWED = ['worklist-v0/hpacs-lite/', 'config/ohif/', 'config/ohif.js', 'studio-mock/'];
const IDENTITY = ['-c', 'user.name=Minhoon Studio', '-c', 'user.email=studio@minhoon-studio.local', '-c', 'commit.gpgsign=false'];

function allowed(file, list = ALLOWED) {
  return list.some(prefix => (prefix.endsWith('/') ? file.startsWith(prefix) : file === prefix));
}

class Sandbox {
  // allowedPaths: where a commit may land (the preview copy of a suggestion leaves studio-mock out: the mock API
  // reads the main sandbox only, so a preview could not show a mock change).
  constructor({ dir, readDir, allowedPaths = ALLOWED }) {
    this.dir = dir;
    this.readDir = readDir;
    this.allowedPaths = allowedPaths;
    this.readers = 0;
    this.readStale = true;
    this.readHead = null;
    this.readLock = Promise.resolve();
    // The last revision a finished commit or undo left on the branch. An undo makes revert commits, amends the last
    // one and may reset them all away, so HEAD in the middle of it is not a revision anyone should be handed.
    this.published = null;
  }

  git(args, { cwd = this.dir, input } = {}) {
    return new Promise(resolve => {
      const child = execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
        resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
      });
      if (input !== undefined) { child.stdin.end(input); }
    });
  }

  async ok(args, opts) {
    const r = await this.git(args, opts);
    if (r.code) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim() || r.stdout.trim()}`);
    return r.stdout;
  }

  async check() {
    if (!fs.existsSync(path.join(this.dir, '.git'))) throw new Error(`sandbox ${this.dir} is not a git repository (run deploy/make-sandbox.py)`);
    await this.ok(['rev-parse', '--verify', 'studio-base']);
    if (this.readDir) await this.worktree(this.readDir);
    this.published = await this.head();
    await this.syncReadTree();
  }

  // A detached working copy of this repository (same objects and refs), created once.
  async worktree(dir) {
    if (fs.existsSync(path.join(dir, '.git'))) return;
    await this.ok(['worktree', 'prune']);
    await this.ok(['worktree', 'add', '--detach', '--force', dir, 'HEAD']);
  }

  async head() { return (await this.ok(['rev-parse', 'HEAD'])).trim(); }
  async publishedHead() { return this.published || this.head(); }
  async base() { return (await this.ok(['rev-parse', 'studio-base'])).trim(); }
  async branch() { return (await this.ok(['rev-parse', '--abbrev-ref', 'HEAD'])).trim(); }

  // Changed paths in the working tree (tracked changes and untracked files), repo-relative with forward slashes.
  async changes() {
    const out = await this.ok(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const entries = []; const parts = out.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const item = parts[i];
      if (!item) continue;
      const code = item.slice(0, 2), file = item.slice(3);
      entries.push({ code, file });
      if (code[0] === 'R' || code[0] === 'C') i++; // rename source follows
    }
    return entries;
  }

  // Put back every change outside the allowed paths; returns what was put back.
  async discardOutside() {
    const blocked = (await this.changes()).filter(e => !this.allows(e.file));
    for (const entry of blocked) await this.restore(entry);
    return blocked.map(e => e.file);
  }

  // Put back every change (a failed edit leaves the last good version on screen).
  async discardAll() {
    for (const entry of await this.changes()) await this.restore(entry);
  }

  async restore(entry) {
    if (entry.code === '??') { fs.rmSync(path.join(this.dir, entry.file), { force: true, recursive: true }); return; }
    await this.git(['checkout', 'HEAD', '--', entry.file]);
  }

  allows(file) { return allowed(file, this.allowedPaths); }
  presentAllowed() { return this.allowedPaths.filter(p => fs.existsSync(path.join(this.dir, p))); }

  async commit({ subject, body = '', trailers = {} }) {
    const changed = (await this.changes()).filter(e => this.allows(e.file));
    if (!changed.length) return null;
    await this.ok(['add', '-A', '--', ...this.presentAllowed()]);
    const message = [subject.replace(/\s+/g, ' ').slice(0, 120), '', body.trim(), '',
      ...Object.entries(trailers).map(([k, v]) => `${k}: ${String(v).replace(/\s+/g, ' ')}`)].join('\n');
    await this.ok([...IDENTITY, 'commit', '-q', '-F', '-'], { input: message });
    const sha = await this.head();
    this.published = sha;
    await this.syncReadTree();
    return { sha, files: changed.map(e => e.file) };
  }

  // Studio commits since the base up to rev, newest first.
  async log(rev = 'HEAD') {
    const out = await this.ok(['log', '--format=%x1e%H%x1f%s%x1f%cI%x1f%b%x1f', '--name-only', `studio-base..${rev}`]);
    const items = [];
    for (const record of out.split('\x1e').filter(r => r.trim())) {
      const [sha, subject, time, body, files] = record.split('\x1f');
      const trailers = {};
      for (const line of (body || '').split('\n')) {
        const m = line.match(/^(Studio-[A-Za-z-]+):\s*(.*)$/);
        if (m) trailers[m[1]] = m[2];
      }
      items.push({ sha, subject, time, trailers, files: (files || '').split('\n').map(s => s.trim()).filter(Boolean) });
    }
    const reverted = new Set(items.map(i => i.trailers['Studio-Revert-Of']).filter(Boolean));
    for (const item of items) item.reverted = reverted.has(item.sha);
    return items;
  }

  // Revert the newest applied change that is not yet reverted (or a given one).
  // Changes applied after the target were built and checked with the target in place, so reverting the target alone
  // makes a tree nobody has checked (a later change may use what it added). An older change is therefore undone
  // together with the still-applied changes after it (newest first, one revert commit each, only when the caller
  // confirms with withLater), which returns to the screen as it was before the target. The result is rebuilt and
  // checked by `validate`; if that fails, everything is put back to the version that was on screen.
  async revert({ sha, user, withLater = false, validate = null }) {
    const items = await this.log();
    const target = sha ? items.find(i => i.sha.startsWith(sha))
      : items.find(i => i.trailers['Studio-Kind'] === 'change' && !i.reverted);
    if (!target) return { error: sha ? '그 변경을 찾지 못했습니다.' : '되돌릴 변경이 없습니다.' };
    if (target.trailers['Studio-Kind'] !== 'change') return { error: '되돌림 기록은 다시 되돌리지 않습니다.' };
    if (target.reverted) return { error: '이미 되돌린 변경입니다.' };
    const later = items.slice(0, items.indexOf(target)).filter(i => i.trailers['Studio-Kind'] === 'change' && !i.reverted);
    if (later.length && !withLater) {
      return { error: `이 변경 뒤에 적용된 변경 ${later.length}개가 이 변경 위에서 만들어졌습니다. 함께 되돌려야 화면이 깨지지 않습니다.`,
        code: 'later-changes', later: later.map(i => ({ sha: i.sha, subject: i.subject })) };
    }
    const start = await this.head();
    const undone = [];
    for (const item of [...later, target]) {
      const r = await this.git(['revert', '--no-commit', item.sha]);
      if (r.code) {
        await this.git(['revert', '--abort']);
        await this.resetTo(start);
        return { error: '다른 되돌림과 겹쳐서 되돌릴 수 없습니다. 최근 변경부터 차례로 되돌려 주세요.' };
      }
      const message = `되돌림: ${item.subject}`.slice(0, 120) + `\n\nStudio-Kind: revert\nStudio-Revert-Of: ${item.sha}\nStudio-User: ${user}\n`;
      await this.ok([...IDENTITY, 'commit', '-q', '-F', '-'], { input: message });
      undone.push(item);
    }
    if (validate) {
      const files = (await this.ok(['diff', '--name-only', start, 'HEAD'])).split('\n').map(s => s.trim()).filter(Boolean);
      let check;
      try { check = await validate(files); } catch (error) { check = { ok: false, errors: [String(error.message || error)] }; }
      if (!check.ok) {
        await this.resetTo(start);
        return { error: '되돌린 결과가 빌드/문법 검사를 통과하지 못해 되돌리지 않았습니다. 화면은 그대로입니다.', errors: check.errors };
      }
      // The builders may regenerate an artifact (bundle, OHIF config); it belongs to the last revert commit.
      if ((await this.changes()).some(e => this.allows(e.file))) {
        await this.ok(['add', '-A', '--', ...this.presentAllowed()]);
        await this.ok([...IDENTITY, 'commit', '-q', '--amend', '--no-edit']);
      }
    }
    const head = await this.head();
    this.published = head;
    await this.syncReadTree();
    return { sha: head, reverted: target, undone };
  }

  async resetTo(sha) {
    await this.git(['reset', '-q', '--hard', sha]);
    await this.discardAll();
  }

  async show(sha) {
    if (!/^[0-9a-f]{7,40}$/.test(sha || '')) return null;
    const r = await this.git(['show', '--stat', '--patch', '--format=%H%n%s%n%cI%n%b', sha]);
    return r.code ? null : r.stdout;
  }

  async diffSinceBase(rev = 'HEAD') {
    return this.ok(['diff', `studio-base..${rev}`, '--', ...ALLOWED]);
  }

  async diffStatSinceBase(rev = 'HEAD') {
    return this.ok(['diff', '--stat', `studio-base..${rev}`, '--', ...ALLOWED]);
  }

  // The 물어보기 Claude reads this detached copy, so a question never reads a half-applied edit. While any question
  // is reading it, the copy stays on its revision (a question must not see one file old and the next one new);
  // the newest commit is checked out when the last reader finishes, or before the next question starts.
  syncReadTree() {
    this.readStale = true;
    return this.underReadLock(() => (this.readers ? null : this.checkoutRead()));
  }

  // Returns the revision the question reads.
  async beginRead() {
    await this.underReadLock(async () => {
      if (!this.readers && this.readStale) await this.checkoutRead();
      this.readers++;
    });
    return this.readHead;
  }

  endRead() {
    this.readers = Math.max(0, this.readers - 1);
    if (!this.readers && this.readStale) this.underReadLock(() => (this.readers ? null : this.checkoutRead()));
  }

  underReadLock(fn) {
    const run = this.readLock.then(fn);
    this.readLock = run.catch(error => console.error('read tree sync failed', error));
    return run;
  }

  async checkoutRead() {
    if (!this.readDir || !fs.existsSync(path.join(this.readDir, '.git'))) { this.readStale = false; return; }
    const head = await this.head();
    const r = await this.git(['checkout', '--detach', '--force', head], { cwd: this.readDir });
    // A failed checkout leaves the copy on its last good revision and stale, so the next sync tries again.
    if (r.code) { console.error('read tree checkout failed', r.stderr.trim()); return; }
    this.readHead = head;
    this.readStale = false;
  }
}

module.exports = { Sandbox, ALLOWED, allowed };
