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

function allowed(file) {
  return ALLOWED.some(prefix => (prefix.endsWith('/') ? file.startsWith(prefix) : file === prefix));
}

class Sandbox {
  constructor({ dir, readDir }) {
    this.dir = dir;
    this.readDir = readDir;
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
    if (this.readDir && !fs.existsSync(path.join(this.readDir, '.git'))) {
      await this.ok(['worktree', 'prune']);
      await this.ok(['worktree', 'add', '--detach', '--force', this.readDir, 'HEAD']);
    }
    await this.syncReadTree();
  }

  async head() { return (await this.ok(['rev-parse', 'HEAD'])).trim(); }
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
    const blocked = (await this.changes()).filter(e => !allowed(e.file));
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

  async commit({ subject, body = '', trailers = {} }) {
    const changed = (await this.changes()).filter(e => allowed(e.file));
    if (!changed.length) return null;
    await this.ok(['add', '-A', '--', ...ALLOWED.filter(p => fs.existsSync(path.join(this.dir, p)))]);
    const message = [subject.replace(/\s+/g, ' ').slice(0, 120), '', body.trim(), '',
      ...Object.entries(trailers).map(([k, v]) => `${k}: ${String(v).replace(/\s+/g, ' ')}`)].join('\n');
    await this.ok([...IDENTITY, 'commit', '-q', '-F', '-'], { input: message });
    const sha = await this.head();
    await this.syncReadTree();
    return { sha, files: changed.map(e => e.file) };
  }

  // Studio commits since the base, newest first.
  async log() {
    const out = await this.ok(['log', '--format=%x1e%H%x1f%s%x1f%cI%x1f%b%x1f', '--name-only', 'studio-base..HEAD']);
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
  async revert({ sha, user }) {
    const items = await this.log();
    const target = sha ? items.find(i => i.sha.startsWith(sha))
      : items.find(i => i.trailers['Studio-Kind'] === 'change' && !i.reverted);
    if (!target) return { error: sha ? '그 변경을 찾지 못했습니다.' : '되돌릴 변경이 없습니다.' };
    if (target.reverted) return { error: '이미 되돌린 변경입니다.' };
    const r = await this.git(['revert', '--no-commit', target.sha]);
    if (r.code) {
      await this.git(['revert', '--abort']);
      return { error: '뒤의 변경과 겹쳐서 이 변경만 따로 되돌릴 수 없습니다. 최근 변경부터 차례로 되돌려 주세요.' };
    }
    const message = `되돌림: ${target.subject}`.slice(0, 120) + `\n\nStudio-Kind: revert\nStudio-Revert-Of: ${target.sha}\nStudio-User: ${user}\n`;
    await this.ok([...IDENTITY, 'commit', '-q', '-F', '-'], { input: message });
    const head = await this.head();
    await this.syncReadTree();
    return { sha: head, reverted: target };
  }

  async show(sha) {
    if (!/^[0-9a-f]{7,40}$/.test(sha || '')) return null;
    const r = await this.git(['show', '--stat', '--patch', '--format=%H%n%s%n%cI%n%b', sha]);
    return r.code ? null : r.stdout;
  }

  async diffSinceBase() {
    return this.ok(['diff', 'studio-base..HEAD', '--', ...ALLOWED]);
  }

  async diffStatSinceBase() {
    return this.ok(['diff', '--stat', 'studio-base..HEAD', '--', ...ALLOWED]);
  }

  // The 물어보기 Claude reads this detached copy, so a question never reads a half-applied edit.
  async syncReadTree() {
    if (!this.readDir || !fs.existsSync(path.join(this.readDir, '.git'))) return;
    const head = await this.head();
    await this.git(['checkout', '--detach', '--force', head], { cwd: this.readDir });
  }
}

module.exports = { Sandbox, ALLOWED, allowed };
