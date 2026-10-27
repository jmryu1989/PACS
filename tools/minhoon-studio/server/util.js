'use strict';
// Small helpers shared by the studio server. No dependencies: the studio runs on a host where we
// install nothing system-wide, so everything here is Node's standard library.
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.wasm': 'application/wasm', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.map': 'application/json',
  '.webmanifest': 'application/manifest+json', '.xml': 'application/xml', '.pdf': 'application/pdf',
};

function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

// Resolve a URL sub-path under a root and refuse anything that escapes it (.., absolute, NUL).
function safeJoin(root, sub) {
  let decoded;
  try { decoded = decodeURIComponent(sub); } catch { return null; }
  if (decoded.includes('\0')) return null;
  const full = path.resolve(root, '.' + path.posix.normalize('/' + decoded.replace(/\\/g, '/')));
  const base = path.resolve(root);
  return full === base || full.startsWith(base + path.sep) ? full : null;
}

function send(res, status, body, headers = {}) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, { 'Content-Length': data.length, ...headers });
  res.end(data);
}

function sendJson(res, status, value, headers = {}) {
  send(res, status, JSON.stringify(value), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limit) {
  const raw = await readBody(req, limit);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString('utf8')); } catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// Live secrets are the only thing the studio never shows (owner 22:3x): a value printed into an internet-facing chat
// log can leak. This masks the common shapes; it is a guard against honest mistakes, not a secret scanner.
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-ant-[A-Za-z0-9_\-]{8,}/g,
  /\bsk-[A-Za-z0-9]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b(?:sessionKey|refreshToken|accessToken|access_token|refresh_token|client_secret|api[_-]?key|password|passwd|secret)("?\s*[:=]\s*"?)([^\s"',;]{6,})/gi,
];
const MASK = '[비밀값 제외]';

function maskSecrets(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, sep, value) => (value !== undefined && typeof sep === 'string'
      ? match.slice(0, match.length - value.length) + MASK : MASK));
  }
  return out;
}

function appendJsonl(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(value) + '\n');
}

function readJsonl(file, limit = Infinity) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const pick = Number.isFinite(limit) ? lines.slice(-limit) : lines;
  const out = [];
  for (const line of pick) { try { out.push(JSON.parse(line)); } catch { /* a torn last line after a crash */ } }
  return out;
}

// Atomic JSON write so a crash mid-write never leaves a half file that the next start cannot parse.
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function readJsonFile(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function today(date = new Date()) {
  // The studio's day is Korea time: Minhoon and the commander both work on KST.
  return new Date(date.getTime() + 9 * 3600e3).toISOString().slice(0, 10);
}

module.exports = {
  mimeOf, safeJoin, send, sendJson, readBody, readJson, parseCookies, maskSecrets, MASK,
  appendJsonl, readJsonl, writeJsonAtomic, readJsonFile, today,
};
