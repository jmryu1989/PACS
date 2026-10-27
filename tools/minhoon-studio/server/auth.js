'use strict';
// Studio login: two named people (Minhoon and the owner), password hashes only, HttpOnly session cookie.
// This is the studio's own door. It never touches the PACS Keycloak, its users or its kin_sid cookie
// (cookies are not port-scoped, so the cookie name is distinct and we never read or log other cookies).
const crypto = require('crypto');
const path = require('path');
const { parseCookies, readJsonFile, writeJsonAtomic } = require('./util');

const COOKIE = 'mstudio_sid';
const SESSION_DAYS = 30;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password, salt = crypto.randomBytes(16)) {
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return { salt: salt.toString('base64'), hash: hash.toString('base64'), scrypt: SCRYPT };
}

function verifyPassword(password, record) {
  if (!record || typeof password !== 'string') return false;
  const params = record.scrypt || SCRYPT;
  const expected = Buffer.from(record.hash, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(record.salt, 'base64'), expected.length,
    { N: params.N, r: params.r, p: params.p });
  return crypto.timingSafeEqual(expected, actual);
}

class Auth {
  constructor(dataDir) {
    this.usersFile = path.join(dataDir, 'users.json');
    this.sessionsFile = path.join(dataDir, 'sessions.json');
    this.sessions = readJsonFile(this.sessionsFile, {});
    this.failures = new Map(); // ip -> [timestamps]; slows password guessing on an internet-facing port
  }

  users() { return readJsonFile(this.usersFile, {}); }

  // Throttle repeated failures per address. The window protects the two accounts from online guessing.
  throttled(ip) {
    const now = Date.now();
    const recent = (this.failures.get(ip) || []).filter(t => now - t < 10 * 60e3);
    this.failures.set(ip, recent);
    return recent.length >= 10;
  }

  login(name, password, ip) {
    if (this.throttled(ip)) return { error: 'throttled' };
    const users = this.users();
    const user = Object.prototype.hasOwnProperty.call(users, name) ? users[name] : null;
    // Compare against a dummy record for unknown names so timing does not reveal which names exist.
    const ok = verifyPassword(String(password || ''), user || DUMMY);
    if (!user || !ok) {
      this.failures.get(ip).push(Date.now());
      return { error: 'invalid' };
    }
    const sid = crypto.randomBytes(32).toString('base64url');
    this.sessions[sid] = { user: name, created: Date.now(), seen: Date.now() };
    this.save();
    return { sid, user: name, displayName: user.displayName || name };
  }

  logout(sid) {
    if (sid && this.sessions[sid]) { delete this.sessions[sid]; this.save(); }
  }

  sessionOf(req) {
    const sid = parseCookies(req.headers.cookie)[COOKIE];
    const entry = sid && this.sessions[sid];
    if (!entry) return null;
    const users = this.users();
    if (!users[entry.user] || Date.now() - entry.seen > SESSION_DAYS * 86400e3) {
      delete this.sessions[sid]; this.save(); return null;
    }
    if (Date.now() - entry.seen > 60e3) { entry.seen = Date.now(); this.save(); }
    return { sid, user: entry.user, displayName: users[entry.user].displayName || entry.user };
  }

  cookie(sid, secure) {
    const attrs = [`${COOKIE}=${sid}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${SESSION_DAYS * 86400}`];
    if (secure) attrs.push('Secure');
    return attrs.join('; ');
  }

  clearCookie(secure) {
    return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
  }

  save() { writeJsonAtomic(this.sessionsFile, this.sessions); }
}

const DUMMY = hashPassword('studio-dummy-password', Buffer.alloc(16, 7));

// `node server.js set-password <name> "<display name>"` reads the password from stdin, so it never appears in the
// process list or shell history. The install script pipes generated passwords through this.
async function setPasswordFromStdin(dataDir, name, displayName) {
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(name || '')) throw new Error('user name must be lowercase letters/digits');
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  // Some shells (PowerShell 5.1) prepend a BOM when piping; generated passwords never contain spaces or a BOM.
  const password = Buffer.concat(chunks).toString('utf8').replace(/^﻿/, '').trim();
  if (password.length < 12) throw new Error('password must be at least 12 characters');
  const file = path.join(dataDir, 'users.json');
  const users = readJsonFile(file, {});
  users[name] = { displayName: displayName || users[name]?.displayName || name, ...hashPassword(password), updated: new Date().toISOString() };
  writeJsonAtomic(file, users);
}

module.exports = { Auth, COOKIE, hashPassword, verifyPassword, setPasswordFromStdin };
