'use strict';
/* TEST-S9-U4 server half (S9-U4b part (b)): the compiled member import gate, feature controller/service and raw parser in a
 * real Nest HTTP application (the product's controller, services, parser and DI; a test guard stands in for Keycloak), over
 * a recording store that keeps ImportOperation's CHECK shapes, its UNIQUE keys, advisory and row locks and rolls a failed
 * transaction back, and a fake Orthanc HTTP server whose stored "files" answer /tags from their own bytes.
 *   REQ-S9-U4-02/03/05/06/12 (+ the server parts of 01/04/07/08/11) -> RISK-S9-U4-* -> this file; contract S9-U4p 4.1-4.9, 5.2, 6.
 * Every contract 4.8 code is reached by behaviour and asserted by HTTP status, outcome token, final/retry replay, the audit
 * row and the stored row. Transport classes are reproduced by replacing globalThis.fetch for POST /instances only (A-R4-07).
 * Assertions bind to the contract's codes, statuses, stored fields and Orthanc calls, never to module source text (D73).
 *
 * Modules: /app/dist/* of kin-api:ci; without /app/dist the repository's tests/service_test_loader.cjs compiles api/src
 * (KIN_TEST_API_SRC selects another source tree, e.g. a mutant copy). Synthetic data only; no network beyond 127.0.0.1.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
if (!fs.existsSync('/app/dist/app.module.js')) require('./service_test_loader.cjs');
require('/app/node_modules/reflect-metadata');
const { NestFactory, APP_GUARD } = require('/app/node_modules/@nestjs/core');
const common = require('/app/node_modules/@nestjs/common');
const { StudyTransferLocalController } = require('/app/dist/study-transfer-local.controller');
const { StudyTransferLocalService } = require('/app/dist/study-transfer-local.service');
const { studyTransferLocalParser } = require('/app/dist/study-transfer-local-parser');
const Gate = require('/app/dist/dicom-import-gate.service');
const { PrismaService } = require('/app/dist/prisma.service');
const { StudyAccessService } = require('/app/dist/study-access.service');
const { AuthService } = require('/app/dist/auth.service');
const { readDicomPart10 } = require('/app/dist/dicom-part10-reader');

process.env.KC_ISSUER = 'https://synthetic.test/auth/realms/kin';
process.env.ORTHANC_USER = 'synthetic-orthanc';
process.env.ORTHANC_PASS = 'synthetic-orthanc-pass';
delete process.env.AUTH_REQUIRED;
const ISSUER = process.env.KC_ISSUER;
const T0 = Date.parse('2026-10-15T00:00:00.000Z');
const NOT_FOUND = '검사를 찾을 수 없습니다';

// ── synthetic callers ──
const caller = (sub, roles, institution = 'inst-a', extra = {}) => ({ sub, actor: sub.replace(/-sub$/, '') + '@synthetic.test', roles, institution, kind: 'member', ...extra });
const TECH = caller('tech-a-sub', ['technician']);
const TECH2 = caller('tech-a2-sub', ['technician']);
const RAD = caller('rad-a-sub', ['radiologist']);
const ADMIN = caller('admin-a-sub', ['admin']);
const ADMIN2 = caller('admin-a2-sub', ['admin']);
const TECH_B = caller('tech-b-sub', ['technician'], 'inst-b');
const ADMIN_B = caller('admin-b-sub', ['admin'], 'inst-b');
const GATEWAY = { ...caller('gw-sub', ['gateway']), kind: 'gateway' };

// ── synthetic Part-10 files (PS3.5 7.1.2 Explicit VR LE) ──
const le16 = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const le32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const even = (b, pad) => (b.length % 2 ? Buffer.concat([b, Buffer.from([pad])]) : b);
const LONG = new Set(['OB', 'OW', 'UN', 'SQ', 'UT']);
function el(g, e, vr, value) {
  const data = Buffer.isBuffer(value) ? value : even(Buffer.from(String(value), 'latin1'), vr === 'UI' ? 0 : 0x20);
  const head = Buffer.concat([le16(g), le16(e), Buffer.from(vr, 'latin1')]);
  return LONG.has(vr) ? Buffer.concat([head, Buffer.alloc(2), le32(data.length), data]) : Buffer.concat([head, le16(data.length), data]);
}
let counter = 0;
const uid = () => `2.25.${T0 / 1000}${process.pid}${++counter}`;
/** One synthetic file; any named value set to null is omitted. */
function dicom(o = {}) {
  const v = { sopClass: '1.2.840.10008.5.1.4.1.1.2', sop: uid(), modality: 'CT', name: 'SYNTHETIC^PATIENT', id: 'SYN-0001', issuer: null,
    birth: '19700101', sex: 'F', study: '2.25.1', series: '2.25.11', frames: null, syntax: '1.2.840.10008.1.2.1', pixel: 16, institution: null, ...o };
  const meta = Buffer.concat([el(2, 1, 'OB', Buffer.from([0, 1])), el(2, 2, 'UI', v.sopClass), el(2, 3, 'UI', v.sop), el(2, 0x10, 'UI', v.syntax), el(2, 0x12, 'UI', '2.25.77')]);
  const named = [[8, 0x16, 'UI', v.sopClass], [8, 0x18, 'UI', v.sop], [8, 0x60, 'CS', v.modality], [8, 0x80, 'LO', v.institution], [0x10, 0x10, 'PN', v.name], [0x10, 0x20, 'LO', v.id],
    [0x10, 0x21, 'LO', v.issuer], [0x10, 0x30, 'DA', v.birth], [0x10, 0x40, 'CS', v.sex], [0x20, 0x0d, 'UI', v.study], [0x20, 0x0e, 'UI', v.series],
    [0x28, 0x08, 'IS', v.frames]].filter(row => row[3] !== null && row[3] !== undefined);
  const body = Buffer.concat([...named.map(([g, e, vr, value]) => el(g, e, vr, value)), el(0x7fe0, 0x10, 'OW', Buffer.alloc(v.pixel, 0x5a))]);
  return Buffer.concat([Buffer.alloc(128), Buffer.from('DICM'), el(2, 0, 'UL', le32(meta.length)), meta, body]);
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const md5 = bytes => createHash('md5').update(bytes).digest('hex');
const orthancId = (patient, study, series, sop) => createHash('sha1').update([patient, study, series, sop].join('|')).digest('hex').match(/.{8}/g).join('-');

// ── a fake Orthanc whose answers come from the stored files themselves ──
function fakeOrthanc() {
  const o = { instances: new Map(), calls: [], fault: null, onPost: null, server: null, url: '' };
  o.store = bytes => {
    const read = readDicomPart10(bytes);
    if (!read.ok) return { status: 400 };
    const h = read.header;
    const id = orthancId(h.patientId ?? '', h.studyInstanceUid, h.seriesInstanceUid, h.sopInstanceUid);
    if (o.instances.has(id)) return { status: 200, body: { ID: id, Status: 'AlreadyStored' } };
    o.instances.set(id, { id, bytes: Buffer.from(bytes), h });
    return { status: 200, body: { ID: id, Status: 'Success' } };
  };
  o.count = () => o.instances.size;
  o.bySop = sop => [...o.instances.values()].filter(i => i.h.sopInstanceUid === sop);
  const tags = (h, simplified) => {
    const t = { PatientID: h.patientId ?? '', StudyInstanceUID: h.studyInstanceUid, SeriesInstanceUID: h.seriesInstanceUid, SOPInstanceUID: h.sopInstanceUid, Modality: h.modality };
    if (!simplified) {
      if (h.patientName !== null) t.PatientName = h.patientName;
      if (h.patientBirthDate !== null) t.PatientBirthDate = h.patientBirthDate;
      if (h.patientSex !== null) t.PatientSex = h.patientSex;
      if (h.issuerOfPatientId !== null) t.IssuerOfPatientID = h.issuerOfPatientId;
    }
    return t;
  };
  o.server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://x');
      // Network IO is never held inside a database transaction (4.4): each call records how many were open.
      const call = { method: req.method, path: url.pathname + url.search, body, openTransactions: o.db?.openTransactions ?? 0 };
      o.calls.push(call);
      if (req.headers.authorization !== 'Basic ' + Buffer.from('synthetic-orthanc:synthetic-orthanc-pass').toString('base64')) { res.writeHead(401); return res.end(); }
      const action = o.fault && await o.fault(call, o);
      if (action?.destroy) return req.socket.destroy();
      if (action?.hang) return;
      if (action?.status) { res.writeHead(action.status); return res.end(action.text ?? ''); }
      if (action?.raw !== undefined) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(action.raw); }
      const json = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
      const m = /^\/instances\/([0-9a-f-]+)\/(file|simplified-tags|tags|attachments\/dicom\/info)$/.exec(url.pathname);
      if (req.method === 'GET' && url.pathname === '/system') return json({ Version: '1.12.5', Name: 'SYNTHETIC' });
      if (req.method === 'POST' && url.pathname === '/tools/find') {
        const q = JSON.parse(body.toString('utf8'));
        const ids = [...o.instances.values()].filter(i => i.h.studyInstanceUid === q.Query.StudyInstanceUID).map(i => i.id).slice(0, q.Limit);
        return json(ids);
      }
      if (req.method === 'POST' && url.pathname === '/tools/lookup') {
        const key = body.toString('latin1');
        return json(o.bySop(key).map(i => ({ ID: i.id, Path: '/instances/' + i.id, Type: 'Instance' })));
      }
      if (req.method === 'POST' && url.pathname === '/instances') {
        const stored = o.store(body);
        if (o.onPost) await o.onPost(stored, o);
        if (action?.lose) return req.socket.destroy();
        return stored.status === 200 ? json(stored.body) : (res.writeHead(stored.status), res.end());
      }
      if (req.method === 'GET' && m) {
        const i = o.instances.get(m[1]);
        if (!i) { res.writeHead(404); return res.end(); }
        if (m[2] === 'file') { res.writeHead(200, { 'Content-Type': 'application/dicom' }); return res.end(action?.bytes ?? i.bytes); }
        if (m[2] === 'simplified-tags') return json(tags(i.h, true));
        if (m[2] === 'tags') return json(tags(i.h, false));
        return json({ UncompressedSize: String(i.bytes.length), UncompressedMD5: md5(i.bytes) });
      }
      res.writeHead(404); res.end();
    });
  });
  return o;
}

// ── a recording store: ImportOperation (CHECK shapes, PK/UNIQUE), StudyState, AuditLog, rights, locks, rollback ──
// The two CHECKs of migration 20261015013945_import_operation, clause by clause. SQL three-valued logic is kept the way the
// migration closes it: every required column is tested IS NOT NULL before its value, so a NULL makes its branch false.
// (JSON null is not representable here - a JS null is SQL NULL; the JSON-null probes run on PostgreSQL in restore-product.)
const CHECK_STATUS = { import: ['open', 'settled'], download: ['prepared', 'sending', 'sent', 'incomplete', 'unconfirmed'], 'study-claim': ['reserved'], 'sop-claim': ['reserved'] };
const present = v => v !== null && v !== undefined;
const jsonObject = v => present(v) && typeof v === 'object' && !Array.isArray(v);
const emptyArray = v => Array.isArray(v) && v.length === 0;
function checkShape(row) {
  const internal = row.ownerIssuer === 'kin-internal' && row.ownerSubject === 'dicom-import-gate' && row.actor === 'dicom-import-gate';
  const owner = [row.institutionId, row.ownerIssuer, row.ownerSubject, row.actor].every(v => typeof v === 'string' && v.length > 0)
    && (row.kind === 'study-claim' || row.kind === 'sop-claim') === internal
    && (row.studyUid === null || (/^[0-9]+(\.[0-9]+)*$/.test(row.studyUid) && row.studyUid.length <= 64));
  const status = CHECK_STATUS[row.kind]?.includes(row.status);
  const kind = status && (
    (row.kind === 'import' && row.studyUid === null && Array.isArray(row.results) && row.results.length <= 100
      && row.manifestSha256 === null && row.download === null && row.claimKey === null && row.claim === null)
    || (row.kind === 'download' && present(row.studyUid) && emptyArray(row.results)
      && present(row.manifestSha256) && /^[0-9a-f]{64}$/.test(row.manifestSha256) && present(row.download) && jsonObject(row.download)
      && row.claimKey === null && row.claim === null)
    || (row.kind === 'study-claim' && present(row.studyUid) && emptyArray(row.results) && row.manifestSha256 === null && row.download === null
      && present(row.claimKey) && row.claimKey === 'study:' + row.studyUid && present(row.claim) && jsonObject(row.claim))
    || (row.kind === 'sop-claim' && present(row.studyUid) && emptyArray(row.results) && row.manifestSha256 === null && row.download === null
      && present(row.claimKey) && /^sop:[0-9]+(\.[0-9]+)*$/.test(row.claimKey) && row.claimKey.length <= 68 && present(row.claim) && jsonObject(row.claim)));
  if (!owner || !kind) throw Object.assign(new Error('check_violation ImportOperation'), { code: 'P2010', meta: { code: '23514' } });
}

function store({ institutions } = {}) {
  const s = { ops: new Map(), states: new Map(), audits: [], clock: T0, migration: true, policies: new Map(), sessions: new Set(),
    rights: new Map(), auditFailure: null, failNextWrite: null, writes: 0, onQuery: null, expiredTokens: new Set(), idpEnded: new Set(), reads: [],
    institutions: institutions ?? [{ id: 'inst-a', name: 'Synthetic A', dicomNames: 'SYN A,SYNTHETIC-A' }, { id: 'inst-b', name: 'Synthetic B', dicomNames: 'SYN B' }] };
  for (const c of [TECH, TECH2, RAD, ADMIN, ADMIN2, TECH_B, ADMIN_B]) s.rights.set(c.sub, { sub: c.sub, approved: true, suspended: false, institution: c.institution, roles: c.roles });
  const advisory = new Map(), rows = new Map();
  const lock = async (map, key, held) => {
    if (held.keys.has(map === advisory ? 'a:' + key : 'r:' + key)) return;
    const prev = map.get(key) || Promise.resolve(); let release; const mine = new Promise(r => { release = r; });
    map.set(key, prev.then(() => mine)); await prev; held.list.push(release); held.keys.add(map === advisory ? 'a:' + key : 'r:' + key);
  };
  const copy = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const out = row => (row ? { ...copy({ ...row, _tx: undefined, createdAt: undefined, updatedAt: undefined }), createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt) } : null);
  // PostgreSQL visibility of a created row: until its transaction commits, only that transaction sees it (READ COMMITTED
  // reads never see another transaction's uncommitted insert, and FOR UPDATE finds nothing to lock). A second insert of the
  // same key waits for the first transaction to end, then fails with a unique violation if that one committed.
  const running = new Map();
  let transactionSeq = 0;
  const fieldMatch = (row, where) => Object.entries(where).every(([k, v]) => (v && typeof v === 'object' && 'gt' in v ? row[k] > v.gt : row[k] === v));
  function api(tx) {
    const undo = fn => tx && tx.undo.push(fn);
    const seen = row => !!row && (!row._tx || (!!tx && row._tx === tx.id));
    const created = (kind, key) => { if (tx) tx.created.push([kind, key]); };
    const settle = async clash => {
      for (;;) {
        const row = clash();
        if (!row || !row._tx || (tx && row._tx === tx.id) || !running.has(row._tx)) return;
        await running.get(row._tx);
      }
    };
    const fail = () => { if (s.failNextWrite && s.failNextWrite()) throw Object.assign(new Error('synthetic storage failure'), { code: 'P1001' }); };
    const ImportOperation = {
      findUnique: async ({ where, select }) => {
        const row = where.id ? s.ops.get(where.id) : [...s.ops.values()].find(r => r.claimKey === where.claimKey && seen(r));
        if (!seen(row)) return null;
        const o = out(row);
        return select ? Object.fromEntries(Object.keys(select).map(k => [k, o[k]])) : o;
      },
      findMany: async ({ where = {}, orderBy, take, select } = {}) => {
        let list = [...s.ops.values()].filter(r => seen(r) && fieldMatch(r, where)).sort((a, b) => (a.id < b.id ? -1 : 1));
        if (take) list = list.slice(0, take);
        s.reads.push(where.kind ?? null);
        return list.map(r => { const o = out(r); return select ? Object.fromEntries(Object.keys(select).map(k => [k, o[k]])) : o; });
      },
      create: async ({ data }) => {
        fail();
        const row = { studyUid: null, results: [], manifestSha256: null, download: null, claimKey: null, claim: null, ...copy(data), createdAt: (data.createdAt ?? new Date(s.clock)).toISOString(), updatedAt: (data.updatedAt ?? new Date(s.clock)).toISOString() };
        await settle(() => s.ops.get(row.id));
        if (row.claimKey !== null) await settle(() => [...s.ops.values()].find(r => r.claimKey === row.claimKey));
        if (s.ops.has(row.id)) throw Object.assign(new Error('Unique constraint failed (id)'), { code: 'P2002' });
        if (row.claimKey !== null && [...s.ops.values()].some(r => r.claimKey === row.claimKey)) throw Object.assign(new Error('Unique constraint failed (claimKey)'), { code: 'P2002' });
        checkShape(row); if (tx) row._tx = tx.id; s.ops.set(row.id, row); created('op', row.id); s.writes++; undo(() => s.ops.delete(row.id)); return out(row);
      },
      update: async ({ where, data }) => {
        fail();
        const before = s.ops.get(where.id); if (!before) throw Object.assign(new Error('not found'), { code: 'P2025' });
        const after = { ...before, ...copy({ ...data, updatedAt: undefined }), updatedAt: (data.updatedAt ?? new Date(s.clock)).toISOString() };
        checkShape(after); s.ops.set(where.id, after); s.writes++; undo(() => s.ops.set(where.id, before)); return out(after);
      },
      delete: async ({ where }) => {
        fail();
        const before = s.ops.get(where.id); if (!before) throw Object.assign(new Error('not found'), { code: 'P2025' });
        s.ops.delete(where.id); s.writes++; undo(() => s.ops.set(where.id, before)); return out(before);
      },
    };
    const db = {
      importOperation: ImportOperation,
      studyState: {
        findUnique: async ({ where }) => (seen(s.states.get(where.uid)) ? copy({ ...s.states.get(where.uid), _tx: undefined }) : null),
        createMany: async ({ data, skipDuplicates }) => {
          fail();
          let count = 0;
          for (const row of data) {
            await settle(() => s.states.get(row.uid));
            if (s.states.has(row.uid)) { if (!skipDuplicates) throw Object.assign(new Error('Unique'), { code: 'P2002' }); continue; }
            s.states.set(row.uid, { teleInstitutionId: null, rs: 'W', ...row, ...(tx ? { _tx: tx.id } : {}) }); created('state', row.uid); count++; s.writes++; undo(() => s.states.delete(row.uid));
          }
          return { count };
        },
      },
      institution: {
        findMany: async () => copy(s.institutions),
        findUnique: async ({ where }) => copy(s.institutions.find(i => i.id === where.id)) ?? null,
      },
      auditLog: {
        create: async ({ data }) => {
          fail();
          if (s.auditFailure && s.auditFailure(data)) throw Object.assign(new Error('synthetic audit failure'), { code: 'P1001' });
          const row = { id: s.audits.length + 1, at: new Date(s.clock), ...data }; s.audits.push(row); s.writes++;
          undo(() => s.audits.splice(s.audits.indexOf(row), 1)); return row;
        },
      },
      memberRights: { findUnique: async ({ where }) => copy(s.rights.get(where.sub)) ?? null },
      authSession: { findUnique: async ({ where }) => (s.sessions.has(where.sid) ? { sid: where.sid } : null) },
      $executeRaw: async (strings, ...values) => {
        const sql = strings.join('?');
        if (sql.includes('pg_advisory_xact_lock(')) { if (!tx) throw new Error('advisory lock outside a transaction'); await lock(advisory, values[0], tx.held); return 1; }
        if (sql.includes('SET LOCAL lock_timeout')) return 0;
        throw new Error('unexpected SQL ' + sql);
      },
      $queryRaw: async (strings, ...values) => {
        const sql = strings.join('?').replace(/\s+/g, ' ');
        // A test may hold or slow one statement (a DB delay, a lock wait elsewhere) before it runs.
        if (s.onQuery) await s.onQuery(sql, values, tx);
        // clock_timestamp(): the database's time when the statement runs, i.e. after the locks taken before it.
        if (sql.includes('clock_timestamp() AS now')) return [{ now: new Date(s.clock) }];
        if (sql.includes("download->'attempts'->-1")) {
          // The attempt CAS of a download chunk: the row lock (if the row exists), then the last attempt's three fields.
          if (!tx) throw new Error('row lock outside a transaction');
          tx.operationLocked = true;
          const row = s.ops.get(values[0]);
          if (!seen(row) || row.kind !== 'download') return [];
          await lock(rows, row.id, tx.held);
          const now = s.ops.get(row.id), last = now.download.attempts[now.download.attempts.length - 1];
          return [{ status: now.status, attemptId: last?.attemptId ?? null, state: last?.state ?? null, leaseUntil: last?.leaseUntil ?? null }];
        }
        if (sql.includes('_prisma_migrations')) {
          if (s.migration === 'error') throw new Error('permission denied for table _prisma_migrations');
          assert.equal(values[0], Gate.IMPORT_MIGRATION);
          return [{ applied: s.migration === true, present: s.migration === true }];
        }
        if (sql.includes('WHERE "claimKey" = ? FOR UPDATE')) {
          if (!tx) throw new Error('row lock outside a transaction');
          // Contract 4.4 lock order: claim rows (sorted) first, then the operation row - never a claim after it.
          if (tx.operationLocked) throw new Error('lock order: a claim row after the operation row');
          const row = [...s.ops.values()].find(r => r.claimKey === values[0] && seen(r));
          if (row) await lock(rows, row.id, tx.held);
          return row ? [out(s.ops.get(row.id))] : [];
        }
        if (sql.includes('WHERE id = ?::uuid FOR UPDATE')) {
          // PostgreSQL READ COMMITTED: FOR UPDATE locks the rows it finds and nothing else - an absent id takes no lock
          // (no gap lock); only an advisory lock taken before it serialises the creation of a new id.
          if (!tx) throw new Error('row lock outside a transaction');
          tx.operationLocked = true;
          if (!seen(s.ops.get(values[0]))) return [];
          await lock(rows, values[0], tx.held);
          return s.ops.has(values[0]) ? [out(s.ops.get(values[0]))] : [];
        }
        if (sql.includes('results @> ?::jsonb')) {
          const [{ attempts: [{ attemptId }] }] = JSON.parse(values[0]);
          return [...s.ops.values()].filter(r => seen(r) && r.kind === 'import' && r.results.some(e => e.attempts.some(a => a.attemptId === attemptId))).map(out);
        }
        if (sql.includes('"StudyAccessPolicy"')) {
          const p = s.policies.get(values[0]);
          return p ? [{ institution: p.institution, revision: 1, policy: p.policy, reason: 'SYNTHETIC', updatedBy: null, updatedAt: null }] : [];
        }
        if (sql.includes('pg_advisory_xact_lock_shared(')) return [{ locked: 1 }];
        throw new Error('unexpected SQL ' + sql);
      },
    };
    return db;
  }
  s.prisma = api(null);
  s.transactions = 0;
  s.openTransactions = 0;
  s.prisma.$transaction = async (fn, options) => {
    s.transactions++;
    // What the gate relies on, not the numbers it picked (D73): READ COMMITTED (each statement sees what committed before
    // it, so a row read after its lock is current) and a bounded wait and duration.
    assert.equal(options?.isolationLevel, 'ReadCommitted');
    assert.ok([options?.maxWait, options?.timeout].every(v => Number.isFinite(v) && v > 0), 'a bounded transaction');
    const tx = { id: ++transactionSeq, undo: [], created: [], held: { list: [], keys: new Set() }, operationLocked: false };
    s.openTransactions++;
    let ended;
    running.set(tx.id, new Promise(resolve => { ended = resolve; }));
    const db = api(tx);
    try {
      const value = await fn(db);
      // Commit: what this transaction created becomes visible to every other one, then its locks go.
      for (const [kind, key] of tx.created) { const row = kind === 'op' ? s.ops.get(key) : s.states.get(key); if (row) delete row._tx; }
      return value;
    }
    catch (error) { for (const fn of tx.undo.reverse()) fn(); throw error; }
    finally { tx.held.list.forEach(release => release()); running.delete(tx.id); ended(); s.openTransactions--; }
  };
  s.op = id => (s.ops.has(id) ? copy({ ...s.ops.get(id), _tx: undefined }) : null);
  s.claim = key => { const row = [...s.ops.values()].find(r => r.claimKey === key); return row ? copy({ ...row, _tx: undefined }) : null; };
  s.file = (id, index) => s.op(id)?.results.find(e => e.index === index);
  s.actions = () => s.audits.map(a => a.action);
  s.advance = ms => { s.clock += ms; };
  return s;
}

// ── the Nest application: the product's controller, services and parser; a test guard stands in for the global AuthGuard ──
class TestGuard {
  canActivate(ctx) {
    const req = ctx.switchToHttp().getRequest();
    const c = JSON.parse(req.headers['x-test-caller'] || 'null');
    if (!c) throw new common.UnauthorizedException();
    Object.assign(req, c, c.session ? { authMethod: 'session', sid: c.session } : { authMethod: 'bearer' });
    // The credential the real guard verified: a bearer caller carries its synthetic access token on the same request.
    if (!c.session) req.headers.authorization = 'Bearer ' + (c.token ?? 'tok:' + c.sub);
    return true;
  }
}
common.Injectable()(TestGuard);

/**
 * AuthService's public checks over the store: a cookie session lives while its row does; a synthetic bearer token
 * 'tok:<sub>' verifies until it is marked expired, and its provider session 'idp:<sub>' until it is marked ended. The
 * real verification and marks are AuthService's own suites; this file asserts what the routes do with their answers.
 */
function fakeAuth(s) {
  return {
    hasSession: async req => { if (s.authFailure) throw s.authFailure(); return s.sessions.has(req.sid); },
    verifyAccessToken: async raw => {
      if (s.authFailure) throw s.authFailure();
      if (!raw.startsWith('tok:') || s.expiredTokens.has(raw)) throw new common.UnauthorizedException('토큰 검증 실패: synthetic');
      return { sub: raw.slice(4), sid: 'idp:' + raw.slice(4) };
    },
    bearerRights: async payload => {
      if (s.idpEnded.has(payload.sid)) throw new common.UnauthorizedException({ code: 'AUTH_SESSION_ENDED', message: '인증 세션이 없습니다' });
      return s.rights.get(payload.sub) ?? null;
    },
  };
}

const apps = [];
after(async () => { for (const a of apps) await a.close(); });

async function harness(options = {}) {
  // options.store: a second server over the same database (a restart), whose startup passes then run over its rows.
  const s = options.store ?? store(options);
  const orthanc = fakeOrthanc();
  orthanc.db = s;
  await new Promise(resolve => orthanc.server.listen(0, '127.0.0.1', resolve));
  process.env.ORTHANC_URL = 'http://127.0.0.1:' + orthanc.server.address().port;
  const access = new StudyAccessService(s.prisma, {}, {});
  class TestModule {}
  common.Module({ controllers: [StudyTransferLocalController], providers: [StudyTransferLocalService, Gate.DicomImportGateService,
    { provide: PrismaService, useValue: s.prisma }, { provide: StudyAccessService, useValue: access }, { provide: AuthService, useValue: fakeAuth(s) },
    { provide: APP_GUARD, useClass: TestGuard }] })(TestModule);
  const mark = s.reads.length;
  const app = await NestFactory.create(TestModule, { rawBody: true, logger: false });
  app.use(studyTransferLocalParser());
  app.setGlobalPrefix('api');
  await app.listen(0, '127.0.0.1');
  // The two startup passes (the gate's import pass, the download service's pass) run beside the server, not in front of
  // it: wait until both have read their last page, so they never meet a test's own rows (a fixed delay raced with them on
  // a loaded host). A test that wants them over its rows starts a second server over the same store (B50).
  const started = () => ['study-claim', 'download'].every(kind => s.reads.slice(mark).includes(kind));
  for (let i = 0; i < 500 && !started(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(started(), 'the startup passes ran');
  const port = app.getHttpServer().address().port;
  const gate = app.get(Gate.DicomImportGateService);
  const transfer = app.get(StudyTransferLocalService);
  const close = async () => { await app.close(); await new Promise(resolve => orthanc.server.close(resolve)); };
  apps.push({ close });
  function request(method, path, { as = TECH, headers = {}, body, raw } = {}) {
    return new Promise((resolve, reject) => {
      const payload = raw ?? (body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)));
      const h = { ...(as ? { 'x-test-caller': JSON.stringify(as) } : {}), ...(payload && !Buffer.isBuffer(body) && body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(payload ? { 'content-length': String(payload.length) } : {}), ...headers };
      const req = http.request({ host: '127.0.0.1', port, method, path, headers: h }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const bytes = Buffer.concat(chunks);
          let json = null; try { json = JSON.parse(bytes.toString('utf8')); } catch { /* binary */ }
          resolve({ status: res.statusCode, body: json, bytes, headers: res.headers, complete: res.complete });
        });
        res.on('error', () => resolve({ status: res.statusCode, body: null, bytes: Buffer.concat(chunks), headers: res.headers, complete: false, aborted: true }));
        // A body the server cut short ends in 'close' without 'end' (resolve is idempotent).
        res.on('close', () => resolve({ status: res.statusCode, body: null, bytes: Buffer.concat(chunks), headers: res.headers, complete: res.complete, aborted: !res.complete }));
      });
      // An archive stopped before its first byte destroys the response before its headers left: the client sees the
      // connection end with no answer and no byte (resolved as such; any other request error still fails the test).
      req.on('error', failure => (failure.code === 'ECONNRESET' ? resolve({ status: null, body: null, bytes: Buffer.alloc(0), headers: {}, complete: false, aborted: true, reset: true }) : reject(failure)));
      if (payload) req.end(payload); else req.end();
    });
  }
  const send = (bytes, { id = randomUUID(), index = 0, as = TECH, expect, headers = {} } = {}) =>
    request('POST', '/api/dicom-import', { as, raw: bytes, headers: { 'content-type': 'application/dicom', 'x-kin-operation-id': id,
      'x-kin-file-index': String(index), ...(expect ? { 'x-kin-expect-study': expect } : {}), ...headers } }).then(r => ({ ...r, id }));
  return { s, orthanc, gate, transfer, request, send, close, port };
}

const posts = o => o.calls.filter(c => c.method === 'POST' && c.path === '/instances').length;
const audits = (s, action) => s.audits.filter(a => a.action === action).map(a => ({ ...a, detail: JSON.parse(a.detail) }));
const own = (s, uid, institutionId = 'inst-a', origin = 'dicom') => s.states.set(uid, { uid, institutionId, teleInstitutionId: null, origin, ss: 'Verified' });
const noPatientValue = (value, ...forbidden) => { const text = JSON.stringify(value); for (const f of forbidden) assert.ok(!text.includes(f), `no ${f} in ${text.slice(0, 200)}`); };

// ════════════════════════════════════════ the import route ════════════════════════════════════════

test('S9U4-B01 new study: stored with read-back, StudyState Unverified/local-import, bound claims, intent before result, replay writes nothing', async () => {
  const h = await harness();
  const study = uid(), bytes = dicom({ study, series: study + '.1', id: 'SYN-NEW-01', name: 'NEW^PATIENT' });
  const first = await h.send(bytes, { expect: study });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual([first.body.outcome, first.body.code, first.body.identity, first.body.writeDisposition], ['stored', null, 'new-study', null]);
  assert.equal(h.orthanc.count(), 1);
  assert.deepEqual(h.orthanc.bySop(first.body.sopUid)[0].bytes, bytes, 'the stored original is the uploaded original');
  const state = h.s.states.get(study);
  assert.deepEqual([state.institutionId, state.ss, state.origin, state.reqHosp], ['inst-a', 'Unverified', 'local-import', 'Synthetic A']);
  const studyClaim = h.s.claim('study:' + study), sopClaim = h.s.claim('sop:' + first.body.sopUid);
  assert.deepEqual([studyClaim.claim.phase, studyClaim.claim.patientId, studyClaim.claim.issuerInstitutionId, studyClaim.claim.heldByAttemptId], ['bound', 'SYN-NEW-01', 'inst-a', null]);
  assert.deepEqual([sopClaim.claim.sha256, sopClaim.claim.bytes, sopClaim.claim.heldByAttemptId], [sha(bytes), bytes.length, null]);
  assert.deepEqual([studyClaim.ownerIssuer, studyClaim.ownerSubject, studyClaim.actor], ['kin-internal', 'dicom-import-gate', 'dicom-import-gate']);
  const op = h.s.op(first.id);
  assert.deepEqual([op.kind, op.status, op.ownerIssuer, op.ownerSubject, op.actor, op.institutionId], ['import', 'settled', ISSUER, TECH.sub, TECH.actor, 'inst-a']);
  const [attempt] = op.results[0].attempts;
  assert.deepEqual([attempt.generation, attempt.phase, attempt.outcome, attempt.transport], [1, 'finished', 'stored', null]);
  assert.deepEqual(h.s.actions(), ['dicom.import.intent', 'dicom.import.result']);
  for (const a of h.s.audits) {
    const d = JSON.parse(a.detail);
    assert.deepEqual([d.institutionId, d.operationId, d.index, d.attemptId], ['inst-a', first.id, 0, attempt.attemptId]);
    assert.equal(a.target, study);
    noPatientValue(d, 'SYN-NEW-01', 'NEW^PATIENT', 'PATIENT');
  }
  noPatientValue(first.body, 'SYN-NEW-01', 'NEW^PATIENT');
  noPatientValue(op.results, 'SYN-NEW-01', 'NEW^PATIENT', 'nameKey');
  const writes = h.s.writes, calls = h.orthanc.calls.length;
  const again = await h.send(bytes, { id: first.id, expect: study });
  assert.deepEqual([again.status, again.body.outcome, again.body.generation], [200, 'stored', 1]);
  assert.equal(h.s.writes, writes, 'a final result replays with zero writes');
  assert.deepEqual(h.orthanc.calls.slice(calls).map(c => c.path), ['/system'], 'a replay reads nothing from Orthanc but the readiness fact');
  assert.equal(posts(h.orthanc), 1, 'no second POST /instances');
  const status = await h.request('GET', '/api/dicom-import/' + first.id);
  assert.deepEqual([status.status, status.body.status, status.body.files[0].outcome], [200, 'settled', 'stored']);
  assert.ok(h.orthanc.calls.every(c => c.openTransactions === 0), 'no Orthanc call while a transaction is open');
});

test('S9U4-B02 the reader codes and the per-file checks before any reservation: 400/409 final, replayed, nothing reserved', async () => {
  const h = await harness();
  const study = uid();
  const cases = [
    ['DICOM_NOT_PART10', Buffer.from('not a dicom file at all'), 400],
    ['DICOM_FILE_META_MISSING', (() => { const b = dicom({ study }); const at = b.indexOf(Buffer.from([2, 0, 0x10, 0])); b.writeUInt16LE(0x0011, at + 2); return b; })(), 400],
    ['DICOM_TRANSFER_SYNTAX_UNSUPPORTED', dicom({ study, syntax: '1.2.840.10008.1.2.1.99' }), 400],
    ['DICOM_MALFORMED', dicom({ study }).subarray(0, 300), 400],
    ['PATIENT_ID_UNREADABLE', dicom({ study, id: 'SYN\u0001ID' }), 400],
    ['PATIENT_ID_MISSING', dicom({ study, id: '' }), 400],
    ['MODALITY_NOT_IMPORTABLE', dicom({ study, modality: 'MG' }), 400],
    ['MODALITY_NOT_IMPORTABLE', dicom({ study, modality: 'US', frames: '12' }), 400],
    ['MODALITY_NOT_IMPORTABLE', dicom({ study, modality: 'XA', frames: '30' }), 400],
    ['MODALITY_NOT_IMPORTABLE', dicom({ study, modality: 'NM' }), 400],
    ['STUDY_UID_MISMATCH', dicom({ study }), 409, uid()],
    ['PATIENT_ISSUER_CONFLICT', dicom({ study, issuer: 'SYN B' }), 409],
    ['PATIENT_ISSUER_CONFLICT', dicom({ study, issuer: 'UNKNOWN HOSPITAL' }), 409],
  ];
  const id = randomUUID();
  for (const [index, [code, bytes, status, expect]] of cases.entries()) {
    const r = await h.send(bytes, { id, index, expect });
    assert.deepEqual([r.status, r.body.outcome, r.body.code], [status, 'rejected', code], code);
    assert.ok(/[가-힣]/.test(r.body.message), code);
    const writes = h.s.writes;
    const again = await h.send(bytes, { id, index, expect });
    assert.deepEqual([again.status, again.body.code, h.s.writes], [status, code, writes], code + ' replays with zero writes');
  }
  const modality = await h.send(dicom({ study, modality: 'MG' }), { id: randomUUID() });
  assert.equal(modality.body.message, '유방촬영 영상은 아직 직접 반입할 수 없습니다.');
  assert.equal((await h.send(dicom({ study, modality: 'US', frames: '2' }), { id: randomUUID() })).body.message, '초음파 동영상은 아직 직접 반입할 수 없습니다.');
  assert.equal((await h.send(dicom({ study, modality: 'XA', frames: '2' }), { id: randomUUID() })).body.message, '혈관조영 동영상은 아직 직접 반입할 수 없습니다.');
  assert.equal([...h.s.ops.values()].filter(r => r.kind !== 'import').length, 0, 'no reservation');
  assert.equal(h.s.states.size, 0, 'no StudyState');
  assert.equal(posts(h.orthanc), 0);
  assert.ok(audits(h.s, 'dicom.import.result').every(a => a.detail.institutionId === 'inst-a' && a.detail.attemptId === null));
  assert.deepEqual(new Set(h.s.actions()), new Set(['dicom.import.result']));
  // Accepted beside them: US/XA single frame, SR, own-institution issuer by id, name or alias (trim/lower).
  for (const [i, o] of [{ modality: 'US' }, { modality: 'XA', frames: '1' }, { modality: 'SR' }, { issuer: ' inst-a ' }, { issuer: 'syn a' }, { issuer: 'SYNTHETIC A' }].entries()) {
    const own = uid();
    const r = await h.send(dicom({ study: own, ...o }), { index: i });
    assert.deepEqual([r.status, r.body.outcome], [200, 'stored'], JSON.stringify(o));
  }
});

test('S9U4-B03 issuer resolution is the whole distinct institution set: alias collisions refuse, order independent', async () => {
  for (const institutions of [
    [{ id: 'inst-a', name: 'A', dicomNames: '' }, { id: 'inst-b', name: 'B', dicomNames: 'inst-a' }],
    [{ id: 'inst-b', name: 'B', dicomNames: 'inst-a' }, { id: 'inst-a', name: 'A', dicomNames: '' }],
  ]) {
    const h = await harness({ institutions });
    const r = await h.send(dicom({ study: uid(), issuer: 'INST-A' }));
    assert.deepEqual([r.status, r.body.code], [409, 'PATIENT_ISSUER_CONFLICT']);
    assert.equal(h.s.states.size + posts(h.orthanc), 0);
  }
});

test('S9U4-B04 a second file is compared with the Study claim: PatientID/demographics conflicts are pre-write 409; a missing side is not_comparable and fills the claim', async () => {
  const h = await harness();
  const study = uid(), series = study + '.1';
  assert.equal((await h.send(dicom({ study, series, id: 'SYN-P1', name: null, sex: 'F' }))).status, 200);
  const id = randomUUID();
  const conflictId = await h.send(dicom({ study, series, id: 'SYN-P2' }), { id, index: 0 });
  assert.deepEqual([conflictId.status, conflictId.body.code, conflictId.body.writeDisposition], [409, 'PATIENT_ID_CONFLICT', 'pre-write']);
  assert.match(conflictId.body.message, /Match\/Unmatch/);
  const conflictSex = await h.send(dicom({ study, series, id: 'SYN-P1', sex: 'M' }), { id, index: 1 });
  assert.deepEqual([conflictSex.status, conflictSex.body.code], [409, 'PATIENT_IDENTITY_CONFLICT']);
  const spaced = await h.send(dicom({ study, series, id: 'SYN-P1', name: 'LATE^NAME', sex: null }), { id, index: 2 });
  assert.deepEqual([spaced.status, spaced.body.outcome, spaced.body.identity], [200, 'stored', 'not_comparable']);
  assert.equal(h.s.claim('study:' + study).claim.nameKey, 'LATE NAME', 'the first non-null value fills an empty claim field');
  const later = await h.send(dicom({ study, series, id: 'SYN-P1', name: 'OTHER^NAME' }), { id, index: 3 });
  assert.deepEqual([later.status, later.body.code], [409, 'PATIENT_IDENTITY_CONFLICT']);
  const caseOnly = await h.send(dicom({ study, series, id: 'syn-p1' }), { id, index: 4 });
  assert.deepEqual([caseOnly.status, caseOnly.body.code], [409, 'PATIENT_ID_CONFLICT'], 'PatientID compares case and inner characters as they are');
  assert.equal(posts(h.orthanc), 2, 'refusals before the write never reach POST /instances');
});

test('S9U4-B05 ownership: a foreign, unassigned or tele-received study is 409 STUDY_OWNERSHIP_CONFLICT with no write and no reservation', async () => {
  const h = await harness();
  const foreign = uid(), unassigned = uid(), tele = uid();
  h.s.states.set(foreign, { uid: foreign, institutionId: 'inst-b', teleInstitutionId: null, origin: 'dicom' });
  h.s.states.set(unassigned, { uid: unassigned, institutionId: null, teleInstitutionId: null, origin: 'dicom' });
  h.s.states.set(tele, { uid: tele, institutionId: 'inst-b', teleInstitutionId: 'inst-a', origin: 'gateway' });
  for (const study of [foreign, unassigned, tele]) {
    const r = await h.send(dicom({ study }));
    assert.deepEqual([r.status, r.body.outcome, r.body.code], [409, 'rejected', 'STUDY_OWNERSHIP_CONFLICT']);
    noPatientValue(r.body, 'inst-b');
  }
  assert.equal([...h.s.ops.values()].filter(r => r.kind !== 'import').length, 0);
  assert.equal(posts(h.orthanc), 0);
});

test('S9U4-B06 Orthanc has the study but no StudyState: 409 STUDY_OWNERSHIP_UNDETERMINED retryable; after registration the same request initialises and stores', async () => {
  const h = await harness();
  const study = uid(), series = study + '.1';
  h.orthanc.store(dicom({ study, series, id: 'SYN-LEGACY' }));
  const bytes = dicom({ study, series, id: 'SYN-LEGACY' });
  const first = await h.send(bytes);
  assert.deepEqual([first.status, first.body.outcome, first.body.code], [409, 'retryable', 'STUDY_OWNERSHIP_UNDETERMINED']);
  assert.equal(h.s.states.size, 0);
  own(h.s, study);
  const again = await h.send(bytes, { id: first.id });
  assert.deepEqual([again.status, again.body.outcome], [200, 'stored'], JSON.stringify(again.body));
  assert.equal(h.orthanc.count(), 2);
});

test('S9U4-B07 legacy claim initialisation: one enumeration and every stored-file header, once per study; a later import makes no further read', async () => {
  const h = await harness();
  const study = uid();
  for (const [series, o] of [[study + '.1', {}], [study + '.1', { name: null }], [study + '.2', { birth: null, sex: null }]])
    h.orthanc.store(dicom({ study, series, id: 'SYN-LEG', ...o }));
  own(h.s, study);
  h.orthanc.calls.length = 0;
  const r = await h.send(dicom({ study, series: study + '.3', id: 'SYN-LEG' }));
  assert.deepEqual([r.status, r.body.outcome, r.body.identity], [200, 'stored', 'matched'], JSON.stringify(r.body));
  const find = h.orthanc.calls.filter(c => c.path === '/tools/find');
  assert.equal(find.length, 1);
  assert.deepEqual(JSON.parse(find[0].body.toString()), { Level: 'Instance', Query: { StudyInstanceUID: study }, Limit: 4097, Expand: false });
  assert.equal(h.orthanc.calls.filter(c => /\/tags\?simplify$/.test(c.path)).length, 3, 'every enumerated instance, by its file header');
  const claim = h.s.claim('study:' + study).claim;
  assert.deepEqual([claim.phase, claim.patientId, claim.nameKey, claim.birthKey, claim.sexKey], ['bound', 'SYN-LEG', 'SYNTHETIC PATIENT', '19700101', 'F']);
  h.orthanc.calls.length = 0;
  assert.equal((await h.send(dicom({ study, series: study + '.3', id: 'SYN-LEG' }))).status, 200);
  assert.equal(h.orthanc.calls.filter(c => c.path === '/tools/find' || c.path.endsWith('?simplify')).length, 0, 'once per study');
});

test('S9U4-B08 legacy initialisation refuses 409 EXISTING_STUDY_IDENTITY_UNRESOLVED on any inconsistency, in both store orders, with zero writes and no claim', async () => {
  const variants = [
    ['two PatientIDs', [{ id: 'SYN-X' }, { id: 'SYN-Y' }]],
    ['issuer on one SOP only', [{ id: 'SYN-X' }, { id: 'SYN-X', issuer: 'SYN B' }]],
    ['own id vs alias issuer', [{ id: 'SYN-X', issuer: 'inst-a' }, { id: 'SYN-X', issuer: 'SYN A' }]],
    ['name differs on one SOP', [{ id: 'SYN-X', name: 'ONE^NAME' }, { id: 'SYN-X', name: 'TWO^NAME' }]],
    ['birth differs', [{ id: 'SYN-X', birth: '19700101' }, { id: 'SYN-X', birth: '19800101' }]],
    ['sex differs', [{ id: 'SYN-X', sex: 'F' }, { id: 'SYN-X', sex: 'M' }]],
  ];
  for (const [name, seeds] of variants) for (const order of [seeds, [...seeds].reverse()]) {
    const h = await harness();
    const study = uid();
    for (const [i, o] of order.entries()) h.orthanc.store(dicom({ study, series: study + '.' + (i + 1), ...o }));
    own(h.s, study);
    const before = h.orthanc.count();
    const r = await h.send(dicom({ study, series: study + '.9', id: 'SYN-X' }));
    assert.deepEqual([r.status, r.body.outcome, r.body.code], [409, 'rejected', 'EXISTING_STUDY_IDENTITY_UNRESOLVED'], name);
    assert.equal(h.orthanc.count(), before, name + ': zero writes');
    assert.equal(h.s.claim('study:' + study), null, name + ': no claim bound');
    assert.match(r.body.message, /관리자에게 이 검사의 환자 정보 확인/);
  }
  // A SOP with the value missing beside one with it present is not a conflict (not_comparable).
  const h = await harness();
  const study = uid();
  h.orthanc.store(dicom({ study, series: study + '.1', id: 'SYN-X', name: null }));
  h.orthanc.store(dicom({ study, series: study + '.2', id: 'SYN-X', name: 'ONE^NAME' }));
  own(h.s, study);
  assert.equal((await h.send(dicom({ study, series: study + '.3', id: 'SYN-X', name: 'ONE^NAME' }))).status, 200);
});

test('S9U4-B09 the enumeration and header-read bounds: 4,097 / malformed / duplicate / oversize lists and any mid-way header failure are 409; only the first enumeration failing is 503', async () => {
  const study = uid();
  async function run(fault, { seed = 2, origin = 'dicom' } = {}) {
    const h = await harness();
    for (let i = 0; i < seed; i++) h.orthanc.store(dicom({ study, series: study + '.1', id: 'SYN-B' }));
    own(h.s, study, 'inst-a', origin);
    h.orthanc.fault = fault;
    const bytes = dicom({ study, series: study + '.2', id: 'SYN-B' });
    const r = await h.send(bytes);
    return { h, r, bytes };
  }
  // Orthanc identifiers are five groups of eight hex digits: a list of 4,097 well-formed ids is refused by the count alone.
  const id = () => randomBytes(20).toString('hex').match(/.{8}/g).join('-');
  const findOnly = raw => call => (call.path === '/tools/find' ? { raw } : null);
  const unresolved = [
    ['4,097 ids', findOnly(JSON.stringify(Array.from({ length: 4097 }, id)))],
    ['not an array', findOnly('{"ids":[]}')],
    ['bad id', findOnly(JSON.stringify(['not-an-orthanc-id']))],
    ['duplicate ids', (() => { const x = id(); return findOnly(JSON.stringify([x, x])); })()],
    ['over 16 MiB', findOnly('[' + '"' + 'a'.repeat(16 * 1024 * 1024) + '"]')],
    ['not JSON', findOnly('[')],
  ];
  for (const [name, fault] of unresolved) {
    const { h, r } = await run(fault);
    assert.deepEqual([r.status, r.body.code], [409, 'EXISTING_STUDY_IDENTITY_UNRESOLVED'], name);
    assert.equal(h.orthanc.calls.filter(c => c.path.endsWith('?simplify')).length, 0, name + ': no header read');
    assert.equal(h.s.claim('study:' + study), null, name);
  }
  let second = 0;
  const midway = [
    ['404 of an instance deleted in between', { status: 404 }], ['500', { status: 500 }], ['non-JSON', { raw: '<html>' }],
    ['connection reset', { destroy: true }], ['over 16 MiB', { raw: '{"PatientID":"' + 'x'.repeat(16 * 1024 * 1024) + '"}' }],
    ['malformed header (null value)', { raw: JSON.stringify({ PatientID: 'SYN-B', StudyInstanceUID: study, SOPInstanceUID: '2.25.9', PatientName: null }) }],
    ['other StudyInstanceUID', { raw: JSON.stringify({ PatientID: 'SYN-B', StudyInstanceUID: '2.25.8', SOPInstanceUID: '2.25.9' }) }],
    ['empty PatientID', { raw: JSON.stringify({ PatientID: ' ', StudyInstanceUID: study, SOPInstanceUID: '2.25.9' }) }],
    ['missing SOPInstanceUID', { raw: JSON.stringify({ PatientID: 'SYN-B', StudyInstanceUID: study }) }],
  ];
  for (const [name, action] of midway) {
    second = 0;
    const { h, r } = await run(call => (call.path.endsWith('?simplify') && ++second === 2 ? action : null));
    assert.deepEqual([r.status, r.body.code], [409, 'EXISTING_STUDY_IDENTITY_UNRESOLVED'], name);
    assert.equal(h.s.claim('study:' + study), null, name + ': initializing claim removed, no baseline');
    assert.equal(posts(h.orthanc), 0, name);
  }
  // 5 s on one header read (the deadline runs to body EOF).
  second = 0;
  const slow = await run(call => (call.path.endsWith('?simplify') && ++second === 1 ? { hang: true } : null));
  assert.deepEqual([slow.r.status, slow.r.body.code], [409, 'EXISTING_STUDY_IDENTITY_UNRESOLVED'], 'header timeout');
  // The 240 s initialisation bound: the monotonic clock passes it during the reads.
  const realNow = performance.now.bind(performance);
  try {
    const late = await run(call => { if (call.path.endsWith('?simplify')) performance.now = () => realNow() + 241000; return null; });
    assert.deepEqual([late.r.status, late.r.body.code], [409, 'EXISTING_STUDY_IDENTITY_UNRESOLVED'], '240 s bound');
  } finally { performance.now = realNow; }
  // Duplicate SOP UIDs across headers.
  const dup = await run(call => (call.path.endsWith('?simplify') ? { raw: JSON.stringify({ PatientID: 'SYN-B', StudyInstanceUID: study, SOPInstanceUID: '2.25.9' }) } : null));
  assert.deepEqual([dup.r.status, dup.r.body.code], [409, 'EXISTING_STUDY_IDENTITY_UNRESOLVED'], 'duplicate SOP UIDs');
  // Zero instances for a study registered by Orthanc synchronisation (origin dicom): 409; for a gateway/local-import one: the file binds.
  const empty = await run(null, { seed: 0 });
  assert.deepEqual([empty.r.status, empty.r.body.code], [409, 'EXISTING_STUDY_IDENTITY_UNRESOLVED']);
  const announced = await run(null, { seed: 0, origin: 'gateway' });
  assert.deepEqual([announced.r.status, announced.r.body.outcome], [200, 'stored']);
  // Only the first enumeration failing (non-200, connection) is 503 ORTHANC_UNAVAILABLE, retryable, never a fresh baseline.
  for (const action of [{ status: 500 }, { destroy: true }]) {
    const { h, r, bytes } = await run(call => (call.path === '/tools/find' ? action : null));
    assert.deepEqual([r.status, r.body.outcome, r.body.code], [503, 'retryable', 'ORTHANC_UNAVAILABLE']);
    assert.equal(h.s.claim('study:' + study), null);
    const attempt = h.s.file(r.id, 0).attempts[0];
    assert.deepEqual([attempt.phase, attempt.transport], ['finished', 'certain-no-write']);
    h.orthanc.fault = null;
    const retry = await h.send(bytes, { id: r.id });
    assert.deepEqual([retry.status, retry.body.outcome, retry.body.generation], [200, 'stored', 2]);
  }
});

test('S9U4-B10 the pre-write lookup: an outside-gate object with the same SOP and other bytes is 409 pre-write, identical bytes are already-present; two objects are SOP_UID_AMBIGUOUS', async () => {
  const h = await harness();
  const study = uid(), series = study + '.1', sop = uid();
  own(h.s, study, 'inst-a', 'gateway');
  const seeded = dicom({ study, series, sop, id: 'SYN-S', pixel: 32 });
  h.orthanc.store(seeded);
  const before = sha(h.orthanc.bySop(sop)[0].bytes);
  const conflict = await h.send(dicom({ study, series, sop, id: 'SYN-S', pixel: 64 }));
  assert.deepEqual([conflict.status, conflict.body.outcome, conflict.body.code, conflict.body.writeDisposition], [409, 'rejected', 'SOP_CONTENT_CONFLICT', 'pre-write']);
  assert.deepEqual([h.orthanc.count(), sha(h.orthanc.bySop(sop)[0].bytes), posts(h.orthanc)], [1, before, 0]);
  const attempt = h.s.file(conflict.id, 0).attempts[0];
  assert.deepEqual([attempt.transport, h.s.claim('study:' + study).claim.heldByAttemptId], ['certain-no-write', null], 'only its own holder released');
  const h2 = await harness();
  own(h2.s, study, 'inst-a', 'gateway');
  h2.orthanc.store(seeded);
  const present = await h2.send(seeded);
  assert.deepEqual([present.status, present.body.outcome, posts(h2.orthanc)], [200, 'already-present', 0]);
  const again = await h2.send(seeded, { id: randomUUID() });
  assert.deepEqual([again.status, again.body.outcome, h2.orthanc.count(), posts(h2.orthanc)], [200, 'already-present', 1, 0], 'same bytes under a new operation');
  const h3 = await harness();
  own(h3.s, study, 'inst-a', 'gateway');
  h3.orthanc.store(dicom({ study, series, sop, id: 'SYN-S' }));
  h3.orthanc.store(dicom({ study, series, sop, id: 'SYN-S2' }));
  h3.orthanc.fault = call => (call.path === '/tools/find' ? { raw: '[]' } : null);
  const ambiguous = await h3.send(dicom({ study, series, sop, id: 'SYN-S' }));
  assert.deepEqual([ambiguous.status, ambiguous.body.code, ambiguous.body.writeDisposition], [409, 'SOP_UID_AMBIGUOUS', 'pre-write']);
});

test('S9U4-B11 member/member: a SOP reserved with other bytes is refused at the claim before any Orthanc read; a held Study or SOP is 409 pending (retryable)', async () => {
  const h = await harness();
  const study = uid(), series = study + '.1', sop = uid();
  assert.equal((await h.send(dicom({ study, series, sop, id: 'SYN-M', pixel: 32 }))).status, 200);
  h.orthanc.calls.length = 0;
  const other = await h.send(dicom({ study, series, sop, id: 'SYN-M', pixel: 48 }), { as: TECH2 });
  assert.deepEqual([other.status, other.body.code, other.body.writeDisposition], [409, 'SOP_CONTENT_CONFLICT', 'pre-write']);
  assert.equal(h.orthanc.calls.filter(c => c.path !== '/system').length, 0, 'refused at the reservation, before any Orthanc call');
  // Same length, other content (a non-identity value of equal size): the reserved hash alone refuses it, still before Orthanc.
  const twinBytes = dicom({ study, series, sop, id: 'SYN-M', pixel: 32, modality: 'MR' });
  assert.equal(twinBytes.length, dicom({ study, series, sop, id: 'SYN-M', pixel: 32 }).length);
  h.orthanc.calls.length = 0;
  const twin = await h.send(twinBytes, { as: TECH2 });
  assert.deepEqual([twin.status, twin.body.code, twin.body.writeDisposition], [409, 'SOP_CONTENT_CONFLICT', 'pre-write'], 'same length, other hash');
  assert.equal(h.orthanc.calls.filter(c => c.path !== '/system').length, 0, 'same length: refused at the reservation');
  // A Study whose holder is a live attempt: the second member is STUDY_WRITE_PENDING; the same request goes through later.
  const busy = uid(), busySop = uid();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  h.orthanc.fault = async call => { if (call.path === '/tools/lookup' && call.body.toString() === busySop) await gate; return null; };
  const slow = h.send(dicom({ study: busy, series: busy + '.1', sop: busySop, id: 'SYN-Q' }));
  await new Promise(resolve => setTimeout(resolve, 100));
  const second = dicom({ study: busy, series: busy + '.1', id: 'SYN-Q' });
  const pending = await h.send(second, { as: TECH2 });
  assert.deepEqual([pending.status, pending.body.outcome, pending.body.code], [409, 'retryable', 'STUDY_WRITE_PENDING']);
  assert.equal(h.s.file(pending.id, 0).attempts.length, 0, 'no send attempt was created');
  release();
  assert.equal((await slow).status, 200);
  const later = await h.send(second, { as: TECH2, id: pending.id });
  assert.deepEqual([later.status, later.body.outcome], [200, 'stored'], 'the retryable code re-executes, it is never a replayed final');
  // A SOP held by a live attempt of another operation while its Study is not (a restored state): SOP_WRITE_PENDING.
  const sopHeld = uid();
  const bytes = dicom({ study, series, sop: sopHeld, id: 'SYN-M' });
  const holder = randomUUID(), at = new Date(h.s.clock).toISOString();
  await h.s.prisma.importOperation.create({ data: { id: randomUUID(), institutionId: 'inst-a', ownerIssuer: ISSUER, ownerSubject: TECH2.sub, actor: TECH2.actor,
    kind: 'import', studyUid: null, status: 'open', results: [{ index: 0, sha256: sha(bytes), bytes: bytes.length, studyUid: study, seriesUid: series,
      sopUid: sopHeld, expectedStudyUid: null, outcome: 'unconfirmed', code: 'IMPORT_UNCONFIRMED', identity: 'matched', writeDisposition: null, at,
      attempts: [{ attemptId: holder, actor: TECH2.actor, generation: 1, ownerInstance: randomUUID(), phase: 'dispatching',
        leaseUntil: new Date(h.s.clock + 20000).toISOString(), startedAt: at, finishedAt: null, outcome: 'unconfirmed', code: 'IMPORT_UNCONFIRMED',
        transport: null, autoRecheckedAt: null, recovery: null }] }] } });
  await h.s.prisma.importOperation.create({ data: { id: randomUUID(), institutionId: 'inst-a', ownerIssuer: 'kin-internal', ownerSubject: 'dicom-import-gate',
    actor: 'dicom-import-gate', kind: 'sop-claim', studyUid: study, status: 'reserved', results: [], claimKey: 'sop:' + sopHeld,
    claim: { schemaVersion: 1, institutionId: 'inst-a', studyUid: study, seriesUid: series, sopUid: sopHeld, patientId: 'SYN-M', issuerInstitutionId: 'inst-a',
      sha256: sha(bytes), bytes: bytes.length, heldByAttemptId: holder, createdAt: new Date(T0).toISOString() } } });
  const sopPending = await h.send(bytes);
  assert.deepEqual([sopPending.status, sopPending.body.outcome, sopPending.body.code], [409, 'retryable', 'SOP_WRITE_PENDING']);
});

test('S9U4-B12 Orthanc unavailable before the write: lookup/file/tags failures are 503 retryable certain-no-write, holders released; the same request then stores exactly one object', async () => {
  for (const failing of ['/tools/lookup', '/file', '/simplified-tags']) {
    const h = await harness();
    const study = uid(), series = study + '.1', sop = uid();
    own(h.s, study, 'inst-a', 'gateway');
    if (failing !== '/tools/lookup') h.orthanc.store(dicom({ study, series, sop, id: 'SYN-U' }));
    h.orthanc.fault = call => (call.path.endsWith(failing) ? { status: 500 } : null);
    const bytes = dicom({ study, series, sop, id: 'SYN-U' });
    const r = await h.send(bytes);
    assert.deepEqual([r.status, r.body.outcome, r.body.code], [503, 'retryable', 'ORTHANC_UNAVAILABLE'], failing);
    const [attempt] = h.s.file(r.id, 0).attempts;
    assert.deepEqual([attempt.phase, attempt.transport], ['finished', 'certain-no-write'], failing);
    assert.equal(h.s.claim('study:' + study).claim.heldByAttemptId, null);
    assert.equal(h.s.claim('sop:' + sop).claim.heldByAttemptId, null);
    assert.equal(h.s.claim('sop:' + sop).claim.sha256, sha(bytes), 'the identity reservation stays');
    h.orthanc.fault = null;
    const retry = await h.send(bytes, { id: r.id });
    assert.deepEqual([retry.status, retry.body.generation], [200, 2], failing);
    assert.equal(h.orthanc.bySop(sop).length, 1);
  }
});

/** Node 22 fetch failures of POST /instances only (A-R4-07): the rest of Orthanc answers normally. */
function failPost(error) {
  const real = globalThis.fetch;
  globalThis.fetch = (url, init) => (String(url).endsWith('/instances') && init?.method === 'POST' ? Promise.reject(error()) : real(url, init));
  return () => { globalThis.fetch = real; };
}
const fetchError = code => () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });

test('S9U4-B13 transport classes: the six connect-phase codes are 503 retryable certain-no-write; anything after connect is 202 unconfirmed transport unknown with holders kept', async () => {
  for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT']) {
    const h = await harness();
    const restore = failPost(fetchError(code));
    let r;
    try { r = await h.send(dicom({ study: uid() })); } finally { restore(); }
    assert.deepEqual([r.status, r.body.outcome, r.body.code], [503, 'retryable', 'ORTHANC_UNAVAILABLE'], code);
    const [attempt] = h.s.file(r.id, 0).attempts;
    assert.deepEqual([attempt.phase, attempt.transport], ['finished', 'certain-no-write'], code);
    assert.ok(Object.values(Object.fromEntries([...h.s.ops.values()].filter(o => o.claim).map(o => [o.claimKey, o.claim.heldByAttemptId]))).every(v => v === null), code);
  }
  const aggregate = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new AggregateError([Object.assign(new Error('a'), { code: 'ECONNREFUSED' }), Object.assign(new Error('b'), { code: 'ECONNREFUSED' })]), { code: undefined }) });
  const unknown = [['ECONNRESET', fetchError('ECONNRESET')], ['EPIPE', fetchError('EPIPE')], ['UND_ERR_SOCKET', fetchError('UND_ERR_SOCKET')],
    ['abort', () => Object.assign(new Error('aborted'), { name: 'AbortError' })], ['other', () => new RangeError('odd')],
    ['TypeError without cause', () => new TypeError('fetch failed')]];
  for (const [name, error] of unknown) {
    const h = await harness();
    const restore = failPost(error);
    let r;
    try { r = await h.send(dicom({ study: uid() })); } finally { restore(); }
    assert.deepEqual([r.status, r.body.outcome, r.body.code], [202, 'unconfirmed', 'IMPORT_UNCONFIRMED'], name);
    const [attempt] = h.s.file(r.id, 0).attempts;
    assert.deepEqual([attempt.phase, attempt.transport], ['unknown', 'unknown'], name);
    assert.ok([...h.s.ops.values()].filter(o => o.claim).every(o => o.claim.heldByAttemptId === attempt.attemptId), name + ': holders kept');
  }
  const h = await harness();
  const restore = failPost(aggregate);
  let r;
  try { r = await h.send(dicom({ study: uid() })); } finally { restore(); }
  assert.deepEqual([r.status, r.body.code], [503, 'ORTHANC_UNAVAILABLE'], 'an AggregateError of refused addresses is a connect failure');
  assert.equal(Gate.connectPhaseFailure(fetchError('ECONNREFUSED')(), true), false, 'our own abort is never a certain no-write');
});

test('S9U4-B14 the response lost after the write: 202 unconfirmed; GET reconciles to stored by SHA-256 without a second write', async () => {
  const h = await harness();
  const study = uid();
  h.orthanc.fault = call => (call.path === '/instances' ? { lose: true } : null);
  const r = await h.send(dicom({ study }));
  assert.deepEqual([r.status, r.body.outcome, r.body.code], [202, 'unconfirmed', 'IMPORT_UNCONFIRMED']);
  assert.equal(h.orthanc.count(), 1);
  h.orthanc.fault = null;
  // While the unknown attempt's lease lives nobody reconciles it (4.4): GET answers Unconfirmed and reads nothing.
  const mark = h.orthanc.calls.length;
  const early = await h.request('GET', '/api/dicom-import/' + r.id);
  assert.deepEqual([early.body.files[0].outcome, h.orthanc.calls.slice(mark).filter(c => c.path !== '/system').length], ['unconfirmed', 0]);
  h.s.advance(31000);
  const status = await h.request('GET', '/api/dicom-import/' + r.id);
  assert.deepEqual([status.status, status.body.files[0].outcome], [200, 'stored']);
  assert.equal(posts(h.orthanc), 1);
  assert.equal(h.s.claim('study:' + study).claim.heldByAttemptId, null);
  assert.deepEqual(audits(h.s, 'dicom.import.result').map(a => a.detail.outcome), ['unconfirmed', 'stored']);
});

test('S9U4-B15 the read-back: a different object after the write is 409 may-have-written (occupancy kept); a read-back failure is 202 unconfirmed', async () => {
  const h = await harness();
  const study = uid(), sop = uid();
  h.orthanc.onPost = (stored, o) => {
    // An outside-gate writer stores another patient's object with the same SOP UID meanwhile (B-U4b-WRITER-RACE).
    if (stored.body?.Status === 'Success') o.store(dicom({ study, series: study + '.1', sop, id: 'SYN-OTHER' }));
    o.onPost = null;
  };
  const r = await h.send(dicom({ study, series: study + '.1', sop, id: 'SYN-MINE' }));
  assert.deepEqual([r.status, r.body.outcome, r.body.code, r.body.writeDisposition], [409, 'rejected', 'SOP_UID_AMBIGUOUS', 'may-have-written']);
  assert.equal(r.body.message, '저장된 원본과 충돌하여 완료를 확인할 수 없습니다.');
  const attempt = h.s.file(r.id, 0).attempts[0];
  assert.equal(h.s.claim('study:' + study).claim.heldByAttemptId, attempt.attemptId, 'a may-have-written conflict keeps the occupancy');
  const blocked = await h.send(dicom({ study, series: study + '.1', id: 'SYN-MINE' }));
  assert.deepEqual([blocked.status, blocked.body.code], [409, 'STUDY_WRITE_PENDING']);
  const h2 = await harness();
  h2.orthanc.fault = call => (call.path.endsWith('/simplified-tags') && posts(h2.orthanc) === 1 ? { status: 500 } : null);
  const lost = await h2.send(dicom({ study: uid() }));
  assert.deepEqual([lost.status, lost.body.outcome, lost.body.code], [202, 'unconfirmed', 'IMPORT_UNCONFIRMED']);
  assert.deepEqual(h2.s.file(lost.id, 0).attempts[0].transport, null, 'the POST itself answered; only the read-back is unknown');
});

test('S9U4-B16 the automatic re-check runs once per unknown attempt: exact -> stored, absence stays 202 with the admin notice, never a resend', async () => {
  const h = await harness();
  const study = uid();
  const bytes = dicom({ study });
  const restore = failPost(fetchError('ECONNRESET'));
  let r;
  try { r = await h.send(bytes); } finally { restore(); }
  assert.equal(r.status, 202);
  h.orthanc.calls.length = 0;
  // Before the lease ran out by DB time the same POST re-checks nothing (4.4: unknown is not touched while its lease lives).
  h.s.advance(29999);
  const early = await h.send(bytes, { id: r.id });
  assert.deepEqual([early.status, h.orthanc.calls.filter(c => c.path !== '/system').length], [202, 0], 'one millisecond before the end');
  h.s.advance(1);
  const first = await h.send(bytes, { id: r.id });
  assert.deepEqual([first.status, first.body.outcome], [202, 'unconfirmed']);
  assert.equal(first.body.message, '저장 결과를 확인하지 못했습니다. 관리자에게 이 파일의 확인을 요청하세요.');
  assert.ok(h.s.file(r.id, 0).attempts[0].autoRecheckedAt);
  assert.equal(h.orthanc.calls.filter(c => c.path === '/tools/lookup').length, 1);
  assert.equal(posts(h.orthanc), 0, 'absence alone never resends');
  h.orthanc.calls.length = 0;
  const second = await h.send(bytes, { id: r.id });
  assert.deepEqual([second.status, h.orthanc.calls.filter(c => c.path !== '/system').length], [202, 0], 'no second automatic read for that attempt');
  // Exact object found by the re-check -> stored, zero writes to Orthanc.
  const h2 = await harness();
  const bytes2 = dicom({ study: uid() });
  h2.orthanc.fault = call => (call.path === '/instances' ? { lose: true } : null);
  const lostAnswer = await h2.send(bytes2);
  h2.orthanc.fault = null;
  h2.s.advance(31000);
  const recheck = await h2.send(bytes2, { id: lostAnswer.id });
  assert.deepEqual([recheck.status, recheck.body.outcome, posts(h2.orthanc)], [200, 'stored', 1]);
  // A re-check whose read fails leaves autoRecheckedAt empty, so the next POST checks once more.
  const h3 = await harness();
  const bytes3 = dicom({ study: uid() });
  const restore3 = failPost(fetchError('EPIPE'));
  let r3;
  try { r3 = await h3.send(bytes3); } finally { restore3(); }
  h3.orthanc.fault = call => (call.path === '/tools/lookup' ? { status: 500 } : null);
  h3.s.advance(31000);
  assert.equal((await h3.send(bytes3, { id: r3.id })).status, 202);
  assert.equal(h3.s.file(r3.id, 0).attempts[0].autoRecheckedAt, null);
  // The failed read gave its reading right back at once: the next POST checks once more, now with an answer.
  h3.orthanc.fault = null;
  h3.orthanc.calls.length = 0;
  assert.equal((await h3.send(bytes3, { id: r3.id })).status, 202);
  assert.ok(h3.s.file(r3.id, 0).attempts[0].autoRecheckedAt);
  assert.equal(h3.orthanc.calls.filter(c => c.path === '/tools/lookup').length, 1);
});

test('S9U4-B17 IMPORT_PERMISSION_REVOKED: rights lost while prepared answer the existing refusal (403/404, no code), retryable, zero writes; restored rights re-execute', async () => {
  const h = await harness();
  const study = uid(), series = study + '.1';
  // Revoke the technician role between the reservation and the dispatch (the lookup is the step before the re-check).
  h.orthanc.fault = call => { if (call.path === '/tools/lookup') h.s.rights.set(TECH.sub, { ...h.s.rights.get(TECH.sub), roles: ['radiologist'] }); return null; };
  const bytes = dicom({ study, series, id: 'SYN-R' });
  const r = await h.send(bytes);
  assert.equal(r.status, 403);
  assert.deepEqual(r.body, { statusCode: 403, message: 'DICOM 반입은(는) technician 권한이 필요합니다', error: 'Forbidden' });
  const entry = h.s.file(r.id, 0);
  assert.deepEqual([entry.outcome, entry.code, entry.attempts[0].transport], ['retryable', 'IMPORT_PERMISSION_REVOKED', 'certain-no-write']);
  assert.equal(posts(h.orthanc), 0);
  assert.equal(h.s.claim('study:' + study).claim.heldByAttemptId, null);
  const status = await h.request('GET', '/api/dicom-import/' + r.id, { as: { ...TECH, roles: ['technician'] } });
  assert.equal(status.body.files[0].code, 'IMPORT_PERMISSION_REVOKED');
  h.orthanc.fault = null;
  h.s.rights.set(TECH.sub, { ...h.s.rights.get(TECH.sub), roles: ['technician'] });
  assert.deepEqual((await h.send(bytes, { id: r.id })).body.outcome, 'stored');
  // StudyAccess lost meanwhile: the existing 404, no code.
  const h2 = await harness();
  const study2 = uid();
  h2.orthanc.fault = call => { if (call.path === '/tools/lookup') h2.s.policies.set(TECH.sub, { institution: 'inst-a', policy: { version: 1, restricted: true, startsAt: null, endsAt: null, rules: [{ patientId: null, modalities: [], dateFrom: null, dateTo: null, studyUids: ['2.25.424242'] }] } }); return null; };
  const r2 = await h2.send(dicom({ study: study2 }));
  assert.deepEqual([r2.status, r2.body.message, r2.body.code], [404, NOT_FOUND, undefined]);
  assert.equal(h2.s.file(r2.id, 0).code, 'IMPORT_PERMISSION_REVOKED');
});

test('S9U4-B18 an expired prepared attempt: GET fences it by CAS (200, retryable IMPORT_ATTEMPT_EXPIRED, certain-no-write, its own holders only, its one result row, zero Orthanc writes; one millisecond earlier nothing), the same POST then re-executes; startup fences it too', async () => {
  const h = await harness();
  const study = uid(), bytes = dicom({ study });
  // The process "ends" right after the intent: the lookup never answers, the client gives up.
  h.orthanc.fault = call => (call.path === '/tools/lookup' ? { hang: true } : null);
  const pending = h.send(bytes);
  await new Promise(resolve => setTimeout(resolve, 150));
  const id = [...h.s.ops.values()].find(o => o.kind === 'import').id;
  h.orthanc.fault = null;
  const [held] = h.s.file(id, 0).attempts;
  h.s.advance(Date.parse(held.leaseUntil) - h.s.clock - 1);
  const writes = h.s.writes;
  const live = await h.request('GET', '/api/dicom-import/' + id);
  assert.deepEqual([live.status, live.body.files[0].outcome, h.s.writes], [200, 'unconfirmed', writes], 'one millisecond before the lease ends: nothing');
  h.s.advance(1);
  const fenced = await h.request('GET', '/api/dicom-import/' + id);
  assert.deepEqual([fenced.status, fenced.body.files[0].outcome, fenced.body.files[0].code], [200, 'retryable', 'IMPORT_ATTEMPT_EXPIRED'], 'contract 4.4 table: GET cancels the right to send by CAS');
  const [old] = h.s.file(id, 0).attempts;
  assert.deepEqual([old.phase, old.outcome, old.code, old.transport], ['finished', 'retryable', 'IMPORT_ATTEMPT_EXPIRED', 'certain-no-write']);
  assert.deepEqual([h.s.claim('study:' + study).claim.heldByAttemptId, h.s.claim('sop:' + h.s.file(id, 0).sopUid).claim.heldByAttemptId], [null, null], 'its own holders released');
  assert.equal(posts(h.orthanc), 0, 'GET never writes to Orthanc');
  const again = await h.send(bytes, { id });
  assert.deepEqual([again.status, again.body.outcome, again.body.generation], [200, 'stored', 2]);
  assert.deepEqual(audits(h.s, 'dicom.import.result').filter(a => a.detail.attemptId === old.attemptId).map(a => a.detail.code), ['IMPORT_ATTEMPT_EXPIRED'],
    'the fenced attempt has exactly one result row');
  await pending;   // the stalled first request fails its own CAS later and writes nothing
  assert.deepEqual([h.s.file(id, 0).attempts.map(a => a.outcome), posts(h.orthanc)], [['retryable', 'stored'], 1], 'the late worker changed nothing');
  // Startup reconciliation: a prepared attempt whose lease ran out is fenced; GET then shows the code with 200.
  const h2 = await harness();
  h2.orthanc.fault = call => (call.path === '/tools/lookup' ? { hang: true } : null);
  const stalled = h2.send(dicom({ study: uid() }));
  await new Promise(resolve => setTimeout(resolve, 150));
  const id2 = [...h2.s.ops.values()].find(o => o.kind === 'import').id;
  h2.s.advance(31000);
  const counts = await h2.gate.reconcileOnStart();
  assert.equal(counts.fenced, 1);
  const shown = await h2.request('GET', '/api/dicom-import/' + id2);
  assert.deepEqual([shown.status, shown.body.files[0].outcome, shown.body.files[0].code], [200, 'retryable', 'IMPORT_ATTEMPT_EXPIRED']);
  h2.orthanc.fault = null;
  void stalled;
});

test('S9U4-B19 ownership of the operation: another subject (same actor), issuer, institution or kind is 409 OPERATION_CONFLICT; other bytes/expected study 409 OPERATION_CONTENT_CONFLICT; GET of another owner 404', async () => {
  const h = await harness();
  const study = uid(), bytes = dicom({ study });
  const first = await h.send(bytes);
  for (const as of [{ ...TECH2, actor: TECH.actor }, TECH_B]) {
    const r = await h.send(bytes, { id: first.id, as });
    assert.deepEqual([r.status, r.body.code], [409, 'OPERATION_CONFLICT'], as.sub);
    assert.equal((await h.request('GET', '/api/dicom-import/' + first.id, { as })).status, 404);
  }
  const saved = process.env.KC_ISSUER;
  process.env.KC_ISSUER = 'https://other.test/realms/kin';
  try { assert.deepEqual((await h.send(bytes, { id: first.id })).body.code, 'OPERATION_CONFLICT', 'another issuer, same sub'); }
  finally { process.env.KC_ISSUER = saved; }
  const renamed = await h.send(bytes, { id: first.id, as: { ...TECH, actor: 'renamed@synthetic.test' } });
  assert.deepEqual([renamed.status, renamed.body.outcome], [200, 'stored'], 'the same subject with a changed actor label');
  const other = await h.send(dicom({ study }), { id: first.id });
  assert.deepEqual([other.status, other.body.code], [409, 'OPERATION_CONTENT_CONFLICT']);
  const expected = await h.send(bytes, { id: first.id, expect: study });
  assert.deepEqual([expected.status, expected.body.code], [409, 'OPERATION_CONTENT_CONFLICT'], 'the expected study is pinned in the first entry');
  assert.equal(h.s.file(first.id, 0).sha256, sha(bytes));
  // An internal reservation row is never a member operation.
  const claimId = h.s.claim('study:' + study).id;
  assert.deepEqual((await h.send(bytes, { id: claimId })).body.code, 'OPERATION_CONFLICT');
  assert.equal((await h.request('GET', '/api/dicom-import/' + claimId)).status, 404);
});

test('S9U4-B20 request-level refusals: roles, credential kind, institution, subject, issuer, readiness, headers and the raw parser at the exact route', async () => {
  const h = await harness();
  const bytes = dicom({ study: uid() });
  const role403 = { statusCode: 403, message: 'DICOM 반입은(는) technician 권한이 필요합니다', error: 'Forbidden' };
  assert.deepEqual((await h.send(bytes, { as: RAD })).body, role403);
  // The durable member rights decide the re-check before the write, not the request's own role list.
  h.s.rights.set(RAD.sub, { ...h.s.rights.get(RAD.sub), roles: ['radiologist', 'technician'] });
  assert.equal((await h.send(bytes, { as: { ...RAD, roles: ['radiologist', 'technician'] } })).status, 200);
  assert.equal((await h.send(dicom({ study: uid() }), { as: ADMIN })).status, 200, 'admin passes need()');
  assert.equal((await h.send(bytes, { as: GATEWAY })).status, 403);
  assert.equal((await h.send(bytes, { as: { ...TECH, roles: ['clinician'] } })).status, 403);
  assert.equal((await h.send(bytes, { as: { ...TECH, institution: null } })).status, 403);
  assert.deepEqual((await h.send(bytes, { as: { ...TECH, sub: '' } })).body.code, 'IMPORT_SUBJECT_MISSING');
  const saved = process.env.KC_ISSUER;
  delete process.env.KC_ISSUER;
  try { const r = await h.send(bytes); assert.deepEqual([r.status, r.body.code], [503, 'IMPORT_ISSUER_UNCONFIGURED']); } finally { process.env.KC_ISSUER = saved; }
  for (const headers of [{ 'x-kin-operation-id': 'not-a-uuid' }, { 'x-kin-file-index': '100' }, { 'x-kin-file-index': '01' }, { 'x-kin-file-index': '-1' },
    { 'x-kin-expect-study': '1.2.x' }])
    assert.deepEqual((await h.request('POST', '/api/dicom-import', { raw: bytes, headers: { 'content-type': 'application/dicom', 'x-kin-operation-id': randomUUID(), 'x-kin-file-index': '0', ...headers } })).body.code,
      'IMPORT_REQUEST_INVALID', JSON.stringify(headers));
  const sendRaw = (payload, headers, path = '/api/dicom-import') => h.request('POST', path, { raw: payload, headers: { 'x-kin-operation-id': randomUUID(), 'x-kin-file-index': '0', ...headers } });
  assert.deepEqual((await sendRaw(bytes, { 'content-type': 'application/octet-stream' })).body.code, 'IMPORT_CONTENT_TYPE_UNSUPPORTED');
  assert.deepEqual((await sendRaw(bytes, { 'content-type': 'application/dicom', 'content-encoding': 'gzip' })).body.code, 'IMPORT_CONTENT_TYPE_UNSUPPORTED');
  const audited = h.s.audits.length;
  const over = await sendRaw(Buffer.alloc(25165825), { 'content-type': 'application/dicom' });
  assert.deepEqual([over.status, over.body.code], [413, 'DICOM_IMPORT_TOO_LARGE']);
  assert.equal(h.s.audits.length, audited, 'a request-level refusal has no file result and no audit row');
  const exact = await sendRaw(Buffer.alloc(25165824), { 'content-type': 'application/dicom' });
  assert.deepEqual([exact.status, exact.body.code], [400, 'DICOM_NOT_PART10'], 'exactly 24 MiB passes the parser and reaches the reader');
  const upper = await sendRaw(Buffer.alloc(25165825), { 'content-type': 'application/dicom' }, '/api/DICOM-import');
  assert.deepEqual([upper.status, upper.body.code], [413, 'DICOM_IMPORT_TOO_LARGE'], 'a case variant reaches the same handler and the same bound');
  const slash = await sendRaw(bytes, { 'content-type': 'application/dicom' }, '/api/dicom-import/');
  assert.deepEqual([slash.status, slash.body.code], [400, 'IMPORT_REQUEST_INVALID'], 'the trailing-slash variant never takes a raw body');
  assert.equal((await h.request('POST', '/api/dicom-import', { as: null, raw: bytes, headers: { 'content-type': 'application/dicom' } })).status, 401);
  // Restricted accounts: a new study 403 STUDY_ACCESS_RESTRICTED_IMPORT; an existing own study outside the policy 404.
  h.s.policies.set(TECH2.sub, { institution: 'inst-a', policy: { version: 1, restricted: true, startsAt: null, endsAt: null, rules: [{ patientId: null, modalities: [], dateFrom: null, dateTo: null, studyUids: ['2.25.424242'] }] } });
  const restricted = await h.send(dicom({ study: uid() }), { as: TECH2 });
  assert.deepEqual([restricted.status, restricted.body.code], [403, 'STUDY_ACCESS_RESTRICTED_IMPORT']);
  const existing = uid(); own(h.s, existing);
  assert.deepEqual([(await h.send(dicom({ study: existing }), { as: TECH2 })).status], [404]);
});

test('S9U4-B21 readiness without an env flag: migration missing or unreadable, or Orthanc /system failing, is 503 IMPORT_NOT_READY on the member routes; GET status still answers stored results', async () => {
  const h = await harness();
  const first = await h.send(dicom({ study: uid() }));
  const study = uid(); own(h.s, study, 'inst-a', 'gateway');
  h.orthanc.store(dicom({ study }));
  const prepared = await h.request('POST', `/api/studies/${study}/original-downloads`, { as: RAD, body: { operationId: randomUUID() } });
  assert.equal(prepared.status, 200);
  for (const migration of [false, 'error']) {
    h.s.migration = migration;
    for (const [method, path, body] of [['POST', '/api/dicom-import'], ['GET', '/api/dicom-import/' + first.id],
      ['POST', `/api/studies/${study}/original-downloads`, { operationId: randomUUID() }], ['GET', `/api/studies/${study}/original-downloads/${prepared.body.operationId}`],
      ['GET', `/api/studies/${study}/original-downloads/${prepared.body.operationId}/archive`], ['POST', `/api/admin/dicom-import/${first.id}/files/0/recovery`, { basis: 'orthanc-restarted', checkedAt: '2026-10-15T00:00:00.000Z' }]]) {
      const as = path.includes('/admin/') ? ADMIN : path.includes('original') ? RAD : TECH;
      const r = method === 'POST' && path === '/api/dicom-import' ? await h.send(dicom({ study: uid() })) : await h.request(method, path, { as, body });
      assert.deepEqual([r.status, r.body?.code, r.body?.message], [503, 'IMPORT_NOT_READY', 'DICOM 반입 기능이 아직 준비되지 않았습니다. 파일은 저장되지 않았습니다. 관리자에게 알려 주세요.'], `${migration} ${method} ${path}`);
    }
  }
  h.s.migration = true;
  const writes = h.s.writes;
  h.orthanc.fault = call => (call.path === '/system' ? { status: 500 } : null);
  for (const [method, path, as, body] of [['POST', `/api/studies/${study}/original-downloads`, RAD, { operationId: randomUUID() }],
    ['GET', `/api/studies/${study}/original-downloads/${prepared.body.operationId}/archive`, RAD], ['POST', `/api/admin/dicom-import/${first.id}/files/0/recovery`, ADMIN, { basis: 'orthanc-restarted', checkedAt: '2026-10-15T00:00:00.000Z' }]])
    assert.deepEqual((await h.request(method, path, { as, body })).body.code, 'IMPORT_NOT_READY', path);
  assert.deepEqual((await h.send(dicom({ study: uid() }))).body.code, 'IMPORT_NOT_READY');
  assert.equal(h.s.writes, writes, 'zero writes');
  const status = await h.request('GET', '/api/dicom-import/' + first.id);
  assert.deepEqual([status.status, status.body.files[0].outcome], [200, 'stored'], 'GET status answers from the database');
  h.orthanc.fault = call => (call.path === '/system' ? { raw: '{"Name":"no version"}' } : null);
  assert.deepEqual((await h.send(dicom({ study: uid() }))).body.code, 'IMPORT_NOT_READY', 'a /system answer without Version');
});

test('S9U4-B22 storage failures: an intent that cannot commit is 503 IMPORT_STORAGE_UNAVAILABLE with zero writes; a result audit failing after the write leaves 202 unconfirmed with holders', async () => {
  const h = await harness();
  h.s.auditFailure = data => data.action === 'dicom.import.intent';
  const study = uid();
  const r = await h.send(dicom({ study }));
  assert.deepEqual([r.status, r.body.code], [503, 'IMPORT_STORAGE_UNAVAILABLE']);
  assert.deepEqual([h.s.states.size, [...h.s.ops.values()].length, posts(h.orthanc)], [0, 0, 0], 'the reservation, StudyState and entry rolled back with the intent');
  h.s.auditFailure = data => data.action === 'dicom.import.result' && JSON.parse(data.detail).outcome === 'stored';
  const bytes = dicom({ study });
  const stored = await h.send(bytes);
  assert.deepEqual([stored.status, stored.body.outcome], [202, 'unconfirmed']);
  const attempt = h.s.file(stored.id, 0).attempts[0];
  assert.equal(attempt.phase, 'dispatching');
  assert.equal(h.s.claim('study:' + study).claim.heldByAttemptId, attempt.attemptId, 'occupancy kept, no rollback-delete at Orthanc');
  assert.equal(h.orthanc.count(), 1);
  h.s.auditFailure = null;
  h.s.advance(31000);
  const again = await h.send(bytes, { id: stored.id });
  assert.deepEqual([again.status, again.body.outcome, posts(h.orthanc)], [200, 'stored', 1], 'a later read-back commits stored with its audit, no new write');
  // A refusal whose result audit cannot be committed is 503 too, and is not replayed as a success.
  const h2 = await harness();
  h2.s.auditFailure = data => data.action === 'dicom.import.result';
  const refused = await h2.send(dicom({ study: uid(), modality: 'MG' }));
  assert.deepEqual([refused.status, refused.body.code, h2.s.ops.size], [503, 'IMPORT_STORAGE_UNAVAILABLE', 0]);
});

test('S9U4-B31 an initialisation interrupted mid-read: the same study is STUDY_WRITE_PENDING while the lease lives; after it expires the next import fences it and reads again from the start', async () => {
  const h = await harness();
  const study = uid();
  h.orthanc.store(dicom({ study, series: study + '.1', id: 'SYN-I' }));
  own(h.s, study);
  let stall = true;
  h.orthanc.fault = call => (stall && call.path.endsWith('?simplify') ? { hang: true } : null);
  const first = h.send(dicom({ study, series: study + '.2', id: 'SYN-I' }));
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(h.s.claim('study:' + study).claim.phase, 'initializing');
  const bytes = dicom({ study, series: study + '.3', id: 'SYN-I' });
  const pending = await h.send(bytes, { as: TECH2 });
  assert.deepEqual([pending.status, pending.body.code], [409, 'STUDY_WRITE_PENDING'], 'an initialisation in progress holds the study');
  stall = false;
  h.s.advance(31000);
  h.orthanc.calls.length = 0;
  const taken = await h.send(bytes, { as: TECH2, id: pending.id });
  assert.deepEqual([taken.status, taken.body.outcome], [200, 'stored'], JSON.stringify(taken.body));
  assert.equal(h.orthanc.calls.filter(c => c.path === '/tools/find').length, 1, 'the reads start again');
  const firstOp = [...h.s.ops.values()].find(o => o.kind === 'import' && o.ownerSubject === TECH.sub);
  const [fenced] = firstOp.results[0].attempts;
  assert.deepEqual([fenced.phase, fenced.code, fenced.transport], ['finished', 'IMPORT_ATTEMPT_EXPIRED', 'certain-no-write']);
  const late = await first;
  assert.deepEqual([late.body.outcome, late.body.code], ['retryable', 'IMPORT_ATTEMPT_EXPIRED'], 'the interrupted request loses its CAS and writes nothing');
  assert.equal(h.s.claim('study:' + study).claim.phase, 'bound');
  assert.equal(audits(h.s, 'dicom.import.result').filter(a => a.detail.attemptId === fenced.attemptId).length, 1, 'one result row for the fenced attempt');
});

test('S9U4-B33 the owner resends after its own initialisation was interrupted: the same POST fences its prepared attempt, drops the initializing claim and reads again', async () => {
  const h = await harness();
  const study = uid();
  h.orthanc.store(dicom({ study, series: study + '.1', id: 'SYN-J' }));
  own(h.s, study);
  let stall = true;
  h.orthanc.fault = call => (stall && call.path.endsWith('?simplify') ? { hang: true } : null);
  const bytes = dicom({ study, series: study + '.2', id: 'SYN-J' });
  const id = randomUUID();
  const first = h.send(bytes, { id });
  await new Promise(resolve => setTimeout(resolve, 150));
  const [held] = h.s.file(id, 0).attempts;
  assert.equal(h.s.claim('study:' + study).claim.heldByAttemptId, held.attemptId);
  stall = false;
  h.s.advance(31000);
  const again = await h.send(bytes, { id });
  assert.deepEqual([again.status, again.body.outcome, again.body.generation], [200, 'stored', 2], JSON.stringify(again.body));
  assert.deepEqual(audits(h.s, 'dicom.import.result').filter(a => a.detail.attemptId === held.attemptId).map(a => a.detail.code), ['IMPORT_ATTEMPT_EXPIRED'],
    'one result row for the fenced attempt');
  assert.equal(h.s.claim('study:' + study).claim.phase, 'bound');
  await first;
});

test('S9U4-B32 the 10 s timers: a live attempt renews its lease; an archive stops supplying bytes once the rights are gone', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const h = await harness();
  const study = uid();
  h.orthanc.fault = call => (call.path === '/tools/lookup' ? { hang: true } : null);
  const stalled = h.send(dicom({ study }));
  await new Promise(resolve => setTimeout(resolve, 150));
  const id = [...h.s.ops.values()].find(o => o.kind === 'import').id;
  const lease = () => h.s.file(id, 0).attempts[0].leaseUntil;
  const before = lease();
  h.s.advance(10000);
  t.mock.timers.tick(10000);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(Date.parse(lease()) - Date.parse(before), 10000, 'renewed to DB now + 30 s');
  void stalled;
  h.orthanc.fault = null;
  // An archive stalled on a slow source reaches no chunk check: the 10 s timer's rights re-read finds the radiologist role
  // gone and stops it while the second original is still held back (the source wait itself is cancelled).
  const dl = await downloadStudy(h, 2), opId = randomUUID();
  assert.equal((await prepare(h, dl, opId)).status, 200);
  let served = 0, release;
  const held = new Promise(resolve => { release = resolve; });
  h.orthanc.fault = async call => (call.path.endsWith('/file') && ++served === 2 ? (await held, null) : null);
  const archive = h.request('GET', `/api/studies/${dl}/original-downloads/${opId}/archive`, { as: RAD });
  await new Promise(resolve => setTimeout(resolve, 200));
  h.s.rights.set(RAD.sub, { ...h.s.rights.get(RAD.sub), roles: ['clinician'] });
  t.mock.timers.tick(10000);
  const answer = await Promise.race([archive, new Promise(resolve => setTimeout(() => resolve('still held'), 3000))]);
  assert.notEqual(answer, 'still held', 'the timer ended the archive before its source answered');
  release();
  assert.ok(answer.bytes.length < Number(answer.headers['content-length']), 'no complete archive after the rights were lost');
  await new Promise(resolve => setTimeout(resolve, 100));
  const [attempt] = h.s.op(opId).download.attempts;
  assert.deepEqual([attempt.state, attempt.responseFinished], ['incomplete', false]);
  assert.equal(attempt.objects.filter(o => o.complete).length, 1);
});

// ════════════════════════════════════════ admin recovery ════════════════════════════════════════

async function unknownAttempt(h, { study = uid(), stored = false } = {}) {
  const bytes = dicom({ study });
  if (stored) h.orthanc.fault = call => (call.path === '/instances' ? { lose: true } : null);
  const restore = stored ? () => {} : failPost(fetchError('ECONNRESET'));
  let r;
  try { r = await h.send(bytes); } finally { restore(); h.orthanc.fault = null; }
  assert.equal(r.status, 202);
  return { id: r.id, bytes, study, attempt: h.s.file(r.id, 0).attempts[0] };
}
const recovery = (h, id, body, as = ADMIN, index = 0) => h.request('POST', `/api/admin/dicom-import/${id}/files/${index}/recovery`, { as, body });

test('S9U4-B23 admin recovery of an unknown attempt with no object: request audit before the re-read, RECOVERED_NO_OBJECT, occupancy released; the owner then stores once', async () => {
  const h = await harness();
  const { id, bytes, study, attempt } = await unknownAttempt(h);
  const body = { basis: 'orthanc-restarted', checkedAt: new Date(T0 + 1000).toISOString() };
  // Not while the unknown attempt's lease lives (4.4): 409, nothing recorded.
  h.s.advance(2000);
  const early = await recovery(h, id, body);
  assert.deepEqual([early.status, early.body.code, audits(h.s, 'dicom.import.recovery.request').length], [409, 'RECOVERY_NOT_APPLICABLE', 0]);
  h.s.advance(29000);
  let requested = null;
  h.orthanc.fault = call => { if (call.path === '/tools/lookup') requested = h.s.actions().slice(); return null; };
  const r = await recovery(h, id, body);
  assert.deepEqual([r.status, r.body.outcome, r.body.code, r.body.message],
    [200, 'retryable', 'RECOVERED_NO_OBJECT', '저장된 원본이 없음을 확인하고 근거를 기록했습니다. 같은 파일을 다시 보낼 수 있습니다.']);
  assert.equal(requested[requested.length - 1], 'dicom.import.recovery.request', 'the request row is committed before the Orthanc re-read');
  assert.deepEqual(h.s.actions().slice(-3), ['dicom.import.recovery.request', 'dicom.import.recovery.result', 'dicom.import.result']);
  for (const a of audits(h.s, 'dicom.import.recovery.request').concat(audits(h.s, 'dicom.import.recovery.result'))) {
    assert.deepEqual([a.actor, a.detail.institutionId, a.detail.operationId, a.detail.attemptId, a.detail.basis, a.detail.adminSubject],
      [ADMIN.actor, 'inst-a', id, attempt.attemptId, 'orthanc-restarted', ADMIN.sub]);
    noPatientValue(a.detail, 'SYN-0001', 'SYNTHETIC^PATIENT');
  }
  assert.equal(h.s.claim('study:' + study).claim.heldByAttemptId, null);
  assert.equal(h.s.claim('sop:' + h.s.file(id, 0).sopUid).claim.sha256, sha(bytes), 'the identity claim stays');
  const resent = await h.send(bytes, { id });
  assert.deepEqual([resent.status, resent.body.outcome, resent.body.generation, h.orthanc.count()], [200, 'stored', 2, 1]);
});

test('S9U4-B24 admin recovery outcomes: exact object -> stored; a different object -> rejected may-have-written with the occupancy-only notice; refusals 403/404/400/409/503 change nothing', async () => {
  const h = await harness();
  const a = await unknownAttempt(h, { stored: true });
  h.s.advance(31000);
  const body = { basis: 'orthanc-log-checked', checkedAt: new Date(T0 + 1000).toISOString() };
  for (const [as, status] of [[TECH, 403], [RAD, 403], [GATEWAY, 403], [ADMIN_B, 404]]) {
    const r = await recovery(h, a.id, body, as);
    assert.equal(r.status, status, as.sub);
    if (status === 403 && as.kind === 'member') assert.equal(r.body.message, '반입 결과 확인은 admin 권한이 필요합니다');
  }
  assert.equal((await recovery(h, randomUUID(), body)).status, 404);
  assert.equal((await recovery(h, a.id, body, ADMIN, 7)).status, 404);
  for (const bad of [{ ...body, extra: 1 }, { basis: 'admin-says-so', checkedAt: body.checkedAt }, { basis: 'orthanc-restarted', checkedAt: '2026-10-15 00:00:01' },
    { basis: 'orthanc-restarted', checkedAt: new Date(T0 - 60000).toISOString() }, { basis: 'orthanc-restarted', checkedAt: new Date(T0 + 3600000).toISOString() }])
    assert.deepEqual((await recovery(h, a.id, bad)).body.code, 'RECOVERY_EVIDENCE_INVALID', JSON.stringify(bad));
  h.orthanc.fault = call => (call.path === '/tools/lookup' ? { status: 500 } : null);
  const unavailable = await recovery(h, a.id, body);
  assert.deepEqual([unavailable.status, unavailable.body.code, unavailable.body.message], [503, 'ORTHANC_UNAVAILABLE', 'Orthanc를 확인하지 못했습니다. 아무것도 바꾸지 않았습니다. 잠시 뒤 다시 시도하세요.']);
  assert.equal(h.s.file(a.id, 0).outcome, 'unconfirmed');
  h.orthanc.fault = null;
  h.s.auditFailure = data => data.action === 'dicom.import.recovery.request';
  assert.deepEqual((await recovery(h, a.id, body)).body.code, 'IMPORT_STORAGE_UNAVAILABLE');
  h.s.auditFailure = null;
  const stored = await recovery(h, a.id, body);
  assert.deepEqual([stored.status, stored.body.outcome, stored.body.message], [200, 'stored', '원본이 저장되어 있음을 확인해 Stored로 정리했습니다. 점유를 해제했습니다.']);
  assert.deepEqual((await recovery(h, a.id, body)).body.code, 'RECOVERY_NOT_APPLICABLE', 'a stored file');
  // A live attempt is not applicable.
  const live = h.send(dicom({ study: uid() }));
  h.orthanc.fault = call => (call.path === '/tools/lookup' ? { hang: true } : null);
  await new Promise(resolve => setTimeout(resolve, 100));
  const liveId = [...h.s.ops.values()].filter(o => o.kind === 'import' && o.status === 'open').map(o => o.id).pop();
  assert.deepEqual((await recovery(h, liveId, body)).body.code, 'RECOVERY_NOT_APPLICABLE');
  h.orthanc.fault = null;
  void live;
  // A different object at Orthanc -> rejected may-have-written, occupancy released, the notice never says "not stored".
  const h2 = await harness();
  const b = await unknownAttempt(h2);
  h2.orthanc.store(dicom({ study: b.study, sop: h2.s.file(b.id, 0).sopUid, id: 'SYN-OTHER', series: h2.s.file(b.id, 0).seriesUid }));
  h2.s.advance(31000);
  const conflict = await recovery(h2, b.id, body);
  assert.deepEqual([conflict.status, conflict.body.outcome, conflict.body.writeDisposition, conflict.body.message],
    [200, 'rejected', 'may-have-written', '원본 충돌로 반입 완료를 확인할 수 없습니다. 점유만 해제했습니다. Orthanc의 원본은 그대로 두었습니다.']);
  assert.equal(h2.s.claim('study:' + b.study).claim.heldByAttemptId, null);
});

test('S9U4-B25 a may-have-written rejection of a multi-file operation: recovery releases the occupancy only; result, Orthanc objects and the other files unchanged', async () => {
  const h = await harness();
  const study = uid(), sop = uid();
  const id = randomUUID();
  assert.equal((await h.send(dicom({ study, series: study + '.1', id: 'SYN-K' }), { id, index: 0 })).status, 200);
  h.orthanc.onPost = (stored, o) => { if (stored.body?.Status === 'Success') o.store(dicom({ study, series: study + '.1', sop, id: 'SYN-OUTSIDE' })); o.onPost = null; };
  const k = await h.send(dicom({ study, series: study + '.1', sop, id: 'SYN-K' }), { id, index: 1 });
  assert.deepEqual([k.status, k.body.code, k.body.writeDisposition], [409, 'SOP_UID_AMBIGUOUS', 'may-have-written']);
  const hashes = [...h.orthanc.instances.values()].map(i => sha(i.bytes)).sort(), count = h.orthanc.count();
  const before = h.s.file(id, 0);
  const r = await recovery(h, id, { basis: 'orthanc-log-checked', checkedAt: new Date(T0).toISOString() }, ADMIN, 1);
  assert.deepEqual([r.status, r.body.outcome, r.body.code, r.body.message],
    [200, 'rejected', 'SOP_UID_AMBIGUOUS', '원본 충돌로 반입 완료를 확인할 수 없습니다. 점유만 해제했습니다. Orthanc의 원본은 그대로 두었습니다.']);
  assert.deepEqual([h.orthanc.count(), [...h.orthanc.instances.values()].map(i => sha(i.bytes)).sort()], [count, hashes]);
  assert.deepEqual(h.s.file(id, 0), before);
  assert.equal(h.s.claim('study:' + study).claim.heldByAttemptId, null);
  assert.deepEqual((await recovery(h, id, { basis: 'orthanc-log-checked', checkedAt: new Date(T0).toISOString() }, ADMIN, 1)).body.code, 'RECOVERY_NOT_APPLICABLE');
  // The admin finds the unknown/may-have-written file in its own institution's result rows; nothing names a patient value.
  const rows = audits(h.s, 'dicom.import.result').filter(a => a.detail.index === 1);
  assert.ok(rows.every(a => a.detail.institutionId === 'inst-a' && a.detail.operationId === id));
  noPatientValue(h.s.audits, 'SYN-K', 'SYN-OUTSIDE', 'SYNTHETIC^PATIENT');
});

// ════════════════════════════════════════ restart and the disposal hook ════════════════════════════════════════

test('S9U4-B26 startup reconciliation: expired dispatching/unknown read-only (exact -> stored, absent -> unknown with its unconfirmed row), initializing claims without a holder removed, a live lease untouched', async () => {
  const h = await harness();
  const a = await unknownAttempt(h, { stored: true });
  const b = await unknownAttempt(h);
  // b's attempt is turned back into a dispatching one whose lease ran out (the API died during the POST).
  const op = h.s.ops.get(b.id); Object.assign(op.results[0].attempts[0], { phase: 'dispatching', transport: null, finishedAt: null });
  // An initializing claim whose holder no attempt names (an interrupted initialisation of an older copy).
  const orphan = uid();
  await h.s.prisma.importOperation.create({ data: { id: randomUUID(), institutionId: 'inst-a', ownerIssuer: 'kin-internal', ownerSubject: 'dicom-import-gate',
    actor: 'dicom-import-gate', kind: 'study-claim', studyUid: orphan, status: 'reserved', results: [], claimKey: 'study:' + orphan,
    claim: { schemaVersion: 1, phase: 'initializing', institutionId: 'inst-a', studyUid: orphan, patientId: null, issuerInstitutionId: null, nameKey: null, birthKey: null, sexKey: null, heldByAttemptId: randomUUID(), createdAt: new Date(T0).toISOString() } } });
  // A live lease of another instance stays as it is.
  const c = await unknownAttempt(h);
  const live = h.s.ops.get(c.id); Object.assign(live.results[0].attempts[0], { phase: 'dispatching', transport: null, finishedAt: null, ownerInstance: randomUUID() });
  h.s.advance(31000);
  live.results[0].attempts[0].leaseUntil = new Date(h.s.clock + 20000).toISOString();
  const before = h.s.op(c.id);
  const counts = await h.gate.reconcileOnStart();
  assert.equal(h.s.file(a.id, 0).outcome, 'stored');
  const [bAttempt] = h.s.file(b.id, 0).attempts;
  assert.deepEqual([h.s.file(b.id, 0).outcome, bAttempt.phase, bAttempt.transport], ['unconfirmed', 'unknown', 'unknown']);
  assert.ok(audits(h.s, 'dicom.import.result').some(r => r.detail.operationId === b.id && r.detail.outcome === 'unconfirmed' && r.detail.attemptId === bAttempt.attemptId));
  assert.equal(h.s.claim('study:' + orphan), null);
  assert.deepEqual(h.s.op(c.id).results, before.results, 'another instance\'s live lease is not taken');
  assert.ok(counts.reconciled >= 2 && counts.claimsRemoved === 1);
  assert.equal(posts(h.orthanc), 1, 'reconciliation never writes to Orthanc');
});

test('S9U4-B27 disposeImportClaims: refused CLAIM_OCCUPIED while any claim of the study has a holder; otherwise the Study and SOP claims are deleted and a later import starts afresh', async () => {
  const h = await harness();
  const study = uid(), series = study + '.1';
  for (let i = 0; i < 2; i++) assert.equal((await h.send(dicom({ study, series, id: 'SYN-H' }))).status, 200);
  const held = uid();
  const unknown = await unknownAttempt(h, { study: held });
  assert.deepEqual(await h.gate.disposeImportClaims(held), { refused: 'CLAIM_OCCUPIED' });
  assert.ok(h.s.claim('study:' + held), 'nothing deleted');
  void unknown;
  const sops = [...h.s.ops.values()].filter(r => r.kind === 'sop-claim' && r.studyUid === study).length;
  assert.equal(sops, 2);
  assert.deepEqual(await h.gate.disposeImportClaims(study), { disposed: 3 });
  assert.equal([...h.s.ops.values()].filter(r => r.claim && r.studyUid === study).length, 0, 'no patient identity value of the disposed study remains');
  assert.ok([...h.s.ops.values()].filter(r => r.kind === 'import').every(r => !JSON.stringify(r.results).includes('SYN-H')));
  // A later import of the same Study UID re-initialises from the objects that remain at Orthanc.
  h.orthanc.calls.length = 0;
  const again = await h.send(dicom({ study, series, id: 'SYN-H' }));
  assert.equal(again.status, 200);
  assert.equal(h.orthanc.calls.filter(c => c.path === '/tools/find').length, 1);
  assert.equal(h.s.claim('study:' + study).claim.patientId, 'SYN-H');
});

// ════════════════════════════════════════ original download ════════════════════════════════════════

function parseZipEntries(zip) {
  const entries = [];
  let at = 0;
  while (zip.readUInt32LE(at) === 0x04034b50) {
    const nameLength = zip.readUInt16LE(at + 26), name = zip.subarray(at + 30, at + 30 + nameLength).toString('utf8');
    let end = at + 30 + nameLength;
    const descriptor = zip.indexOf(Buffer.from([0x50, 0x4b, 0x07, 0x08]), end);
    const size = zip.readUInt32LE(descriptor + 8);
    entries.push({ name, data: zip.subarray(end, end + size) });
    at = descriptor + 16;
  }
  return entries;
}

async function downloadStudy(h, objects = 3) {
  const study = uid();
  own(h.s, study, 'inst-a', 'gateway');
  for (let i = 0; i < objects; i++) h.orthanc.store(dicom({ study, series: study + '.' + (i % 2 + 1), id: 'SYN-D', pixel: 64 + i * 2 }));
  return study;
}
const prepare = (h, study, id = randomUUID(), as = RAD) => h.request('POST', `/api/studies/${study}/original-downloads`, { as, body: { operationId: id } });

test('S9U4-B28 download: prepare -> one fixed manifest (replayed for the same id), archive streams every stored original byte-identical with a final manifest.json; Sent once', async () => {
  const h = await harness();
  const study = await downloadStudy(h, 3);
  const id = randomUUID();
  const first = await prepare(h, study, id);
  assert.deepEqual([first.status, first.body.state, first.body.objects], [200, 'prepared', 3], JSON.stringify(first.body));
  const op = h.s.op(id);
  assert.equal(createHash('sha256').update(op.download.manifestCanonical).digest('hex'), op.manifestSha256);
  assert.deepEqual([op.kind, op.studyUid, op.download.destination, op.download.targetStudyUid], ['download', study, 'browser-download', study]);
  const replay = await prepare(h, study, id);
  assert.deepEqual([replay.status, replay.body.manifestSha256, audits(h.s, 'original.download.prepare').length], [200, first.body.manifestSha256, 1]);
  assert.equal((await prepare(h, await downloadStudy(h, 1), id)).body.code, 'OPERATION_CONFLICT', 'same id, another study');
  assert.equal((await prepare(h, study, id, { ...TECH2 })).body.code, 'OPERATION_CONFLICT', 'same id, another subject');
  assert.equal((await h.request('GET', `/api/studies/${study}/original-downloads/${id}`, { as: TECH2 })).status, 404);
  assert.equal((await h.request('GET', `/api/studies/${study}/original-downloads/${id}/archive`, { as: TECH2 })).status, 404);
  const zip = await h.request('GET', `/api/studies/${study}/original-downloads/${id}/archive`, { as: RAD });
  assert.equal(zip.status, 200);
  assert.equal(zip.headers['content-type'], 'application/zip');
  assert.equal(zip.headers['content-disposition'], `attachment; filename="KIN-originals-${id.slice(0, 8)}.zip"`);
  assert.equal(Number(zip.headers['content-length']), zip.bytes.length);
  const entries = parseZipEntries(zip.bytes);
  assert.equal(entries.length, 4);
  const stored = new Map([...h.orthanc.instances.values()].map(i => [sha(i.bytes), i]));
  for (const e of entries.slice(0, 3)) assert.ok(stored.has(sha(e.data)), e.name + ' is a stored original, byte for byte');
  const manifest = JSON.parse(entries[3].data.toString('utf8'));
  assert.equal(entries[3].name, 'manifest.json');
  assert.deepEqual(manifest.objects.map(o => o.sha256).sort(), entries.slice(0, 3).map(e => sha(e.data)).sort());
  noPatientValue(manifest, 'SYN-D', 'SYNTHETIC^PATIENT');
  await new Promise(resolve => setTimeout(resolve, 50));
  const sent = h.s.op(id);
  const [attempt] = sent.download.attempts;
  assert.deepEqual([sent.status, attempt.state, attempt.responseFinished, attempt.archiveSha256], ['sent', 'sent', true, sha(zip.bytes)]);
  assert.ok(attempt.objects.every(o => o.complete && o.sha256 && o.bytesSupplied === o.bytesRead));
  assert.deepEqual(h.s.actions().filter(a => a.startsWith('original.')), ['original.download.prepare', 'original.download.intent', 'original.download.result']);
  for (const a of audits(h.s, 'original.download.result').concat(audits(h.s, 'original.download.intent'), audits(h.s, 'original.download.prepare'))) {
    assert.equal(a.detail.institutionId, 'inst-a');
    assert.equal(a.detail.operationId, id);
    noPatientValue(a.detail, 'SYN-D');
  }
  assert.deepEqual(audits(h.s, 'original.download.result')[0].detail.objects.map(o => o.sha256).sort(), manifest.objects.map(o => o.sha256).sort());
  const status = await h.request('GET', `/api/studies/${study}/original-downloads/${id}`, { as: RAD });
  assert.deepEqual([status.body.state, status.body.note], ['sent', '서버가 이 검사의 모든 원본을 보냈습니다. 내 컴퓨터에 저장됐는지는 브라우저의 다운로드 목록에서 확인하세요.']);
  // Sent is final for its operation (5.3): 409 DOWNLOAD_ALREADY_SENT, byte 0, nothing changed; a new id prepares again.
  const before = h.s.op(id), audited = h.s.audits.length;
  const again = await h.request('GET', `/api/studies/${study}/original-downloads/${id}/archive`, { as: RAD });
  assert.deepEqual([again.status, again.body.code, again.headers['content-type'].startsWith('application/json')], [409, 'DOWNLOAD_ALREADY_SENT', true]);
  assert.deepEqual([h.s.op(id), h.s.audits.length], [before, audited], 'state and audit unchanged');
  const next = randomUUID();
  assert.equal((await prepare(h, study, next)).status, 200);
  const second = await h.request('GET', `/api/studies/${study}/original-downloads/${next}/archive`, { as: RAD });
  assert.equal(second.bytes.length, Number(second.headers['content-length']));
  assert.ok(h.orthanc.calls.every(c => c.openTransactions === 0), 'no Orthanc read while a transaction is open');
});

test('S9U4-B29 download refusals before byte 1: roles, foreign/tele study 404, MANIFEST_INCOMPLETE, ARCHIVE_TOO_LARGE, MANIFEST_CHANGED, DOWNLOAD_IN_PROGRESS, MANIFEST_STORE_INVALID', async () => {
  const h = await harness();
  const study = await downloadStudy(h, 2);
  assert.equal((await prepare(h, study, randomUUID(), { ...TECH, roles: ['clinician'] })).status, 403);
  assert.equal((await prepare(h, study, randomUUID(), GATEWAY)).status, 403);
  assert.equal((await prepare(h, study, randomUUID(), TECH)).status, 200, 'technician');
  assert.equal((await prepare(h, study, randomUUID(), ADMIN)).status, 200, 'admin');
  assert.equal((await prepare(h, study, randomUUID(), TECH_B)).status, 404, 'another institution');
  const tele = uid(); h.s.states.set(tele, { uid: tele, institutionId: 'inst-b', teleInstitutionId: 'inst-a', origin: 'gateway' });
  const teleAnswer = await prepare(h, tele);
  assert.deepEqual([teleAnswer.status, teleAnswer.body.message], [404, NOT_FOUND], 'tele-received: one identical 404');
  assert.equal((await h.request('POST', `/api/studies/${study}/original-downloads`, { as: RAD, body: { operationId: randomUUID(), extra: 1 } })).body.code, 'IMPORT_REQUEST_INVALID');
  const empty = uid(); own(h.s, empty, 'inst-a', 'gateway');
  assert.deepEqual((await prepare(h, empty)).body.code, 'MANIFEST_INCOMPLETE');
  h.orthanc.fault = call => (call.path.endsWith('/attachments/dicom/info') ? { status: 500 } : null);
  assert.deepEqual((await prepare(h, study)).body.code, 'MANIFEST_INCOMPLETE');
  h.orthanc.fault = call => (call.path === '/tools/find' ? { raw: JSON.stringify(Array.from({ length: 65534 }, (_, n) => ('0000000' + n.toString(16)).slice(-8) + '-00000000-00000000-00000000-00000000')) } : null);
  assert.deepEqual((await prepare(h, study)).body.code, 'ARCHIVE_TOO_LARGE');
  h.orthanc.fault = null;
  const id = randomUUID();
  assert.equal((await prepare(h, study, id)).status, 200);
  h.orthanc.store(dicom({ study, series: study + '.1', id: 'SYN-D', pixel: 200 }));
  const changed = await h.request('GET', `/api/studies/${study}/original-downloads/${id}/archive`, { as: RAD });
  assert.deepEqual([changed.status, changed.body.code], [409, 'MANIFEST_CHANGED']);
  assert.equal(h.s.op(id).download.attempts.length, 0, 'no attempt, no byte');
  const study2 = await downloadStudy(h, 1), id2 = randomUUID();
  assert.equal((await prepare(h, study2, id2)).status, 200);
  const row = h.s.ops.get(id2);
  row.download.attempts.push({ attemptId: randomUUID(), number: 1, ownerSubject: RAD.sub, actor: RAD.actor, manifestSha256: row.manifestSha256, destination: 'browser-download',
    state: 'sending', startedAt: new Date(h.s.clock).toISOString(), endedAt: null, ownerInstance: randomUUID(), leaseUntil: new Date(h.s.clock + 20000).toISOString(),
    objects: [], archiveSha256: null, responseFinished: false });
  row.status = 'sending';
  assert.deepEqual((await h.request('GET', `/api/studies/${study2}/original-downloads/${id2}/archive`, { as: RAD })).body.code, 'DOWNLOAD_IN_PROGRESS');
  h.s.advance(31000);
  const retried = await h.request('GET', `/api/studies/${study2}/original-downloads/${id2}/archive`, { as: RAD });
  assert.equal(retried.status, 200, 'an expired sending attempt is fenced to unconfirmed and a new attempt starts');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(h.s.op(id2).download.attempts.map(a => a.state), ['unconfirmed', 'sent']);
  const study3 = await downloadStudy(h, 1), id3 = randomUUID();
  assert.equal((await prepare(h, study3, id3)).status, 200);
  h.s.ops.get(id3).download.manifestCanonical += ' ';
  assert.deepEqual((await h.request('GET', `/api/studies/${study3}/original-downloads/${id3}/archive`, { as: RAD })).body.code, 'MANIFEST_STORE_INVALID');
  assert.deepEqual((await h.request('GET', `/api/studies/${study3}/original-downloads/${id3}`, { as: RAD })).body.code, 'MANIFEST_STORE_INVALID');
});

test('S9U4-B30 download streams that stop: an MD5 change of a stored original is Incomplete and never a successful ZIP; a client disconnect is Incomplete; restart marks an expired sending attempt Unconfirmed', async () => {
  const h = await harness();
  const study = await downloadStudy(h, 2);
  const id = randomUUID();
  assert.equal((await prepare(h, study, id)).status, 200);
  let served = 0;
  h.orthanc.fault = call => (call.path.endsWith('/file') && ++served === 2 ? { bytes: Buffer.alloc([...h.orthanc.instances.values()][1].bytes.length, 0x41) } : null);
  const broken = await h.request('GET', `/api/studies/${study}/original-downloads/${id}/archive`, { as: RAD });
  assert.equal(broken.status, 200, 'the headers were already sent');
  assert.ok(broken.bytes.length < Number(broken.headers['content-length']), 'a short body, never a closed successful ZIP');
  await new Promise(resolve => setTimeout(resolve, 50));
  const [attempt] = h.s.op(id).download.attempts;
  assert.deepEqual([attempt.state, attempt.responseFinished, attempt.archiveSha256], ['incomplete', false, null]);
  assert.deepEqual(attempt.objects.map(o => o.complete), [true, false]);
  assert.equal(audits(h.s, 'original.download.result')[0].detail.state, 'incomplete');
  h.orthanc.fault = null;
  // The client goes away while the first object is held back.
  let release;
  const held = new Promise(resolve => { release = resolve; });
  h.orthanc.fault = async call => (call.path.endsWith('/file') ? (await held, null) : null);
  const port = h.port;
  await new Promise(resolve => {
    // Nothing has been written yet (the first original is held back), so the client leaves before any byte.
    const req = http.request({ host: '127.0.0.1', port, path: `/api/studies/${study}/original-downloads/${id}/archive`, headers: { 'x-test-caller': JSON.stringify(RAD) } },
      res => { res.on('data', () => {}); res.on('error', () => {}); });
    req.on('error', () => {});
    req.end();
    setTimeout(() => { req.destroy(); setTimeout(() => { release(); setTimeout(resolve, 300); }, 100); }, 300);
  });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(h.s.op(id).download.attempts[1].state, 'incomplete');
  h.orthanc.fault = null;
  // An expired sending attempt (the API died mid-stream after its first checkpoint) is closed Unconfirmed by the download
  // startup pass with its own result row; its checkpoint stays as it was.
  const row = h.s.ops.get(id);
  const checkpointed = row.download.attempts[0].objects.filter(o => o.complete);
  const stoppedId = randomUUID();
  row.download.attempts.push({ ...row.download.attempts[0], attemptId: stoppedId, number: 3, state: 'sending', endedAt: null, objects: checkpointed,
    archiveSha256: null, responseFinished: false, leaseUntil: new Date(h.s.clock + 1000).toISOString() });
  row.status = 'sending';
  h.s.advance(5000);
  await h.gate.reconcileOnStart();
  assert.equal(h.s.op(id).download.attempts[2].state, 'sending', 'the import pass leaves download attempts to the download pass');
  assert.equal(await h.transfer.expireDownloads(), 1);
  const last = h.s.op(id).download.attempts[2];
  assert.deepEqual([last.state, last.objects.length, last.objects[0].sha256], ['unconfirmed', 1, checkpointed[0].sha256]);
  assert.deepEqual(audits(h.s, 'original.download.result').filter(a => a.detail.attemptId === stoppedId).map(a => [a.detail.state, a.detail.reason]),
    [['unconfirmed', 'lease-expired']], 'the closed attempt has exactly one result row');
  const retried = await h.request('GET', `/api/studies/${study}/original-downloads/${id}/archive`, { as: RAD });
  assert.equal(retried.status, 200);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(h.s.op(id).download.attempts.map(a => a.state), ['incomplete', 'incomplete', 'unconfirmed', 'sent'], 'retries add attempts; earlier supply facts stay');
});

// ── the archive's check before every chunk (U4BB-03), the persisted formats (U4BB-08), the manifest readings (U4BB-09) and
// the close of an expired attempt (U4BB-10) ──

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const archivePath = (study, id) => `/api/studies/${study}/original-downloads/${id}/archive`;
const deniedPolicy = { institution: 'inst-a', policy: { version: 1, restricted: true, startsAt: null, endsAt: null,
  rules: [{ patientId: null, modalities: [], dateFrom: null, dateTo: null, studyUids: ['2.25.424242'] }] } };
const resultRows = (h, attemptId) => audits(h.s, 'original.download.result').filter(a => a.detail.attemptId === attemptId);
const casSql = sql => sql.includes("download->'attempts'->-1");

/** An archive of a two-object study whose second original is held back until release(); the first is supplied and checkpointed. */
async function heldArchive(h, as = RAD) {
  const study = await downloadStudy(h, 2), id = randomUUID();
  assert.equal((await prepare(h, study, id, as)).status, 200);
  let served = 0, release;
  const held = new Promise(resolve => { release = resolve; });
  h.orthanc.fault = async call => (call.path.endsWith('/file') && ++served === 2 ? (await held, null) : null);
  const archive = h.request('GET', archivePath(study, id), { as });
  await sleep(200);
  const manifest = JSON.parse(h.s.op(id).download.manifestCanonical);
  return { study, id, archive, release, second: h.orthanc.instances.get(manifest.objects[1].orthancId).bytes };
}

test('S9U4-B34 before every chunk: the attempt CAS in the database and the rights now, with no window or cache; a revocation, an ended cookie or provider session, an expired token, lost StudyAccess or a moved study stop the stream before its next byte; a lease past by DB time fences it', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });   // the 10 s timer never fires: only the check before each chunk acts
  // ASTRA-03: the role is revoked as the first original starts to answer, a few milliseconds before its first chunk.
  {
    const h = await harness();
    const study = await downloadStudy(h, 1), id = randomUUID();
    assert.equal((await prepare(h, study, id)).status, 200);
    h.orthanc.fault = call => { if (call.path.endsWith('/file')) h.s.rights.set(RAD.sub, { ...h.s.rights.get(RAD.sub), roles: ['clinician'] }); return null; };
    const r = await h.request('GET', archivePath(study, id), { as: RAD });
    assert.ok(r.bytes.length === 0 && (r.reset || (r.status === 200 && !r.complete)), 'not one archive byte after the revocation');
    await sleep(50);
    const [a] = h.s.op(id).download.attempts;
    assert.deepEqual([a.state, a.responseFinished, a.objects.map(o => o.bytesSupplied)], ['incomplete', false, [0]]);
    assert.deepEqual(resultRows(h, a.attemptId).map(x => x.detail.state), ['incomplete']);
  }
  // ASTRA-15: the database's clock passes the lease as the first original starts: the CAS fails, not one byte, Unconfirmed.
  {
    const h = await harness();
    const study = await downloadStudy(h, 1), id = randomUUID();
    assert.equal((await prepare(h, study, id)).status, 200);
    let moved = false;
    h.orthanc.fault = call => { if (!moved && call.path.endsWith('/file')) { moved = true; h.s.advance(31000); } return null; };
    const r = await h.request('GET', archivePath(study, id), { as: RAD });
    assert.ok(r.bytes.length === 0 && (r.reset || (r.status === 200 && !r.complete)), 'not one byte after the lease expired by DB time');
    await sleep(50);
    const [a] = h.s.op(id).download.attempts;
    assert.deepEqual([a.state, a.responseFinished, a.objects.length], ['unconfirmed', false, 0]);
    assert.deepEqual(resultRows(h, a.attemptId).map(x => [x.detail.state, x.detail.reason]), [['unconfirmed', 'lease-expired']]);
  }
  // Between chunks (the second original held back): each loss stops the stream before the held original's first byte.
  const losses = [
    ['role revoked', RAD, h => h.s.rights.set(RAD.sub, { ...h.s.rights.get(RAD.sub), roles: ['clinician'] })],
    ['cookie session logged out', { ...RAD, session: 'sid-rad-a' }, h => h.s.sessions.delete('sid-rad-a')],
    ['provider session ended', RAD, h => h.s.idpEnded.add('idp:' + RAD.sub)],
    ['access token expired', RAD, h => h.s.expiredTokens.add('tok:' + RAD.sub)],
    ['StudyAccess restricted', RAD, h => h.s.policies.set(RAD.sub, deniedPolicy)],
    ['study moved to another institution', RAD, (h, held) => { h.s.states.get(held.study).institutionId = 'inst-b'; }],
  ];
  for (const [name, as, lose] of losses) {
    const h = await harness();
    h.s.sessions.add('sid-rad-a');
    const held = await heldArchive(h, as);
    lose(h, held);
    held.release();
    const r = await held.archive;
    assert.ok(r.bytes.length < Number(r.headers['content-length']) && !r.bytes.includes(held.second), name + ': no byte of the held original');
    await sleep(50);
    const [a] = h.s.op(held.id).download.attempts;
    assert.deepEqual([a.state, a.objects.map(o => [o.complete, o.bytesSupplied > 0])], ['incomplete', [[true, true], [false, false]]], name);
  }
  // Positive control: the cookie session alive and the rights unchanged -> the whole archive, Sent.
  const h = await harness();
  h.s.sessions.add('sid-rad-a');
  const kept = await heldArchive(h, { ...RAD, session: 'sid-rad-a' });
  kept.release();
  const whole = await kept.archive;
  assert.equal(whole.bytes.length, Number(whole.headers['content-length']));
  await sleep(50);
  assert.equal(h.s.op(kept.id).download.attempts[0].state, 'sent');
});

test('S9U4-B35 the chunk CAS judges by the database time read after its row lock; a CAS that does not answer in time is lost; a stalled worker loses to the retry that fenced it; the final close needs the live lease; a lease near its end is renewed by the chunk check', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  // A database that does not answer the CAS within its bound: fenced, Unconfirmed, the first object's checkpoint kept.
  {
    const h = await harness();
    const held = await heldArchive(h);
    h.s.onQuery = async sql => { if (casSql(sql)) await sleep(6000); };
    held.release();
    const r = await held.archive;
    assert.ok(!r.bytes.includes(held.second), 'a slow CAS admits no byte');
    await sleep(1500);
    h.s.onQuery = null;
    const [a] = h.s.op(held.id).download.attempts;
    assert.deepEqual([a.state, a.objects.length, a.objects[0].complete], ['unconfirmed', 1, true], 'the completed checkpoint stays');
    assert.deepEqual(resultRows(h, a.attemptId).map(x => x.detail.state), ['unconfirmed']);
  }
  // A lock wait: the CAS queues behind another transaction's row lock while the database's clock passes the lease. The
  // time it judges by is read after the lock, so the chunk is refused (a time read at the transaction start would pass).
  {
    const h = await harness();
    const held = await heldArchive(h);
    let unlock, locked, waiting;
    const holding = new Promise(resolve => { unlock = resolve; });
    const isLocked = new Promise(resolve => { locked = resolve; });
    const casWaiting = new Promise(resolve => { waiting = resolve; });
    const other = h.s.prisma.$transaction(async tx => {
      await tx.$queryRaw(['SELECT * FROM "ImportOperation" WHERE id = ', '::uuid FOR UPDATE'], held.id);
      locked();
      await holding;
    }, { isolationLevel: 'ReadCommitted', maxWait: 4000, timeout: 8000 });
    await isLocked;
    h.s.onQuery = async sql => { if (casSql(sql)) waiting(); };
    held.release();
    await casWaiting;
    await sleep(50);
    h.s.advance(31000);
    unlock();
    await other;
    const r = await held.archive;
    h.s.onQuery = null;
    assert.ok(!r.bytes.includes(held.second));
    await sleep(50);
    const [a] = h.s.op(held.id).download.attempts;
    assert.deepEqual([a.state, a.objects.length], ['unconfirmed', 1]);
    assert.deepEqual(resultRows(h, a.attemptId).map(x => [x.detail.state, x.detail.reason]), [['unconfirmed', 'lease-expired']]);
  }
  // A stalled worker and a retry: the first archive stalls past its lease; the retry fences it (Unconfirmed, its one
  // result row) and sends the whole archive; the stalled worker then supplies no further byte and changes nothing.
  {
    const h = await harness();
    const held = await heldArchive(h);
    const [first] = h.s.op(held.id).download.attempts;
    h.s.advance(31000);
    const retry = await h.request('GET', archivePath(held.study, held.id), { as: RAD });
    assert.equal(retry.bytes.length, Number(retry.headers['content-length']));
    held.release();
    const stalled = await held.archive;
    assert.ok(!stalled.bytes.includes(held.second), 'the fenced worker supplies no byte of the held original');
    await sleep(50);
    const attempts = h.s.op(held.id).download.attempts;
    assert.deepEqual(attempts.map(a => a.state), ['unconfirmed', 'sent']);
    assert.equal(attempts[0].objects.length, 1, 'its checkpoint stays');
    assert.deepEqual(resultRows(h, first.attemptId).map(x => [x.detail.state, x.detail.reason]), [['unconfirmed', 'lease-expired']]);
    assert.deepEqual(resultRows(h, attempts[1].attemptId).map(x => x.detail.state), ['sent']);
  }
  // The final close needs the live lease: every byte went out, but the DB clock passed the lease before the close.
  {
    const h = await harness();
    const study = await downloadStudy(h, 2), id = randomUUID();
    assert.equal((await prepare(h, study, id)).status, 200);
    let moved = false;
    h.s.onQuery = async (sql, values) => {
      const row = h.s.ops.get(values[0]);
      if (!moved && sql.includes('WHERE id = ?::uuid FOR UPDATE') && row?.download?.attempts?.at(-1)?.objects?.length === 2) { moved = true; h.s.advance(31000); }
    };
    const r = await h.request('GET', archivePath(study, id), { as: RAD });
    h.s.onQuery = null;
    assert.equal(r.bytes.length, Number(r.headers['content-length']), 'every byte was supplied');
    await sleep(50);
    const [a] = h.s.op(id).download.attempts;
    assert.deepEqual([a.state, a.responseFinished, a.archiveSha256, a.objects.filter(o => o.complete).length], ['unconfirmed', false, null, 2],
      'never Sent without the live lease; both checkpoints stay');
    assert.deepEqual(resultRows(h, a.attemptId).map(x => x.detail.state), ['unconfirmed']);
  }
  // The chunk CAS takes the operation's advisory lock before its row, like every other transaction on the row: with a
  // writer holding the advisory lock and then asking for the row, neither waits on the other in a cycle (no deadlock).
  {
    const h = await harness();
    const held = await heldArchive(h);
    h.s.advance(15000);   // the next chunk check renews the lease, so it locks the row twice in one transaction
    let release, locked;
    const holding = new Promise(resolve => { release = resolve; });
    const isLocked = new Promise(resolve => { locked = resolve; });
    let rowTaken = false;
    const writer = h.s.prisma.$transaction(async tx => {
      await h.gate.lockOperationKey(tx, held.id);
      locked();
      await holding;
      await tx.$queryRaw(['SELECT * FROM "ImportOperation" WHERE id = ', '::uuid FOR UPDATE'], held.id);
      rowTaken = true;
    }, { isolationLevel: 'ReadCommitted', maxWait: 4000, timeout: 8000 });
    await isLocked;
    held.release();
    await sleep(150);   // the archive reaches its next chunk check meanwhile
    release();
    await Promise.race([writer, sleep(3000)]);
    assert.ok(rowTaken, 'the writer got the row: the chunk check did not hold it while waiting for the advisory lock');
    const whole = await held.archive;
    assert.equal(whole.bytes.length, Number(whole.headers['content-length']));
  }
  // Less than 20 s of the lease left by DB time: the check before the next chunk renews it to DB now + 30 s.
  {
    const h = await harness();
    const held = await heldArchive(h);
    h.s.advance(15000);
    // The lease as the second object's checkpoint locks the row (the last full-row lock while one object is checkpointed).
    let leaseAtCheckpoint = null;
    h.s.onQuery = async (sql, values) => {
      const last = h.s.ops.get(values[0])?.download?.attempts?.at(-1);
      if (sql.includes('WHERE id = ?::uuid FOR UPDATE') && last?.objects?.length === 1) leaseAtCheckpoint = last.leaseUntil;
    };
    held.release();
    const whole = await held.archive;
    h.s.onQuery = null;
    assert.equal(whole.bytes.length, Number(whole.headers['content-length']));
    await sleep(50);
    assert.equal(h.s.op(held.id).download.attempts[0].state, 'sent');
    assert.equal(leaseAtCheckpoint, new Date(h.s.clock + 30000).toISOString(), 'renewed by a chunk check before the second checkpoint');
  }
});

test('S9U4-B36 a stored download row outside its persisted format is 503 MANIFEST_STORE_INVALID with byte 0, on prepare replay, status and archive, and is never rebuilt', async () => {
  const h = await harness();
  const study = await downloadStudy(h, 2);
  const template = randomUUID();
  assert.equal((await prepare(h, study, template)).status, 200);
  assert.equal((await h.request('GET', archivePath(study, template), { as: RAD })).status, 200);
  await sleep(50);
  const sent = h.s.op(template).download.attempts[0];
  assert.equal(sent.state, 'sent');
  const incomplete = { ...sent, state: 'incomplete', archiveSha256: null, responseFinished: false, objects: sent.objects.slice(0, 1) };
  const corruptions = [
    ['an extra key (ASTRA-11)', d => { d.unlisted = 'not-in-the-closed-schema'; }],
    ['another destination (ASTRA-11)', d => { d.destination = 'external-destination'; }],
    ['a missing key', d => { delete d.preparedAt; }],
    ['a JSON null target', d => { d.targetStudyUid = null; }],
    ['another target study', d => { d.targetStudyUid = '2.25.999'; }],
    ['another schema version', d => { d.schemaVersion = 2; }],
    ['a date that does not exist', d => { d.preparedAt = '2026-02-30T00:00:00.000Z'; }],
    ['manifest text that is not its hash', d => { d.manifestCanonical += ' '; }],
    ['a manifest of another study', d => { d.manifestCanonical = d.manifestCanonical.split(study).join('2.25.999'); }],
    ['an attempt with an extra key', d => { d.attempts = [{ ...incomplete, unlisted: 1 }]; }],
    ['an attempt id of JSON null', d => { d.attempts = [{ ...incomplete, attemptId: null }]; }],
    ['duplicate attempt numbers', d => { d.attempts = [incomplete, { ...incomplete, attemptId: randomUUID() }]; }],
    ['one attempt id twice', d => { d.attempts = [incomplete, { ...incomplete, number: 2 }]; }],
    ['another owner subject', d => { d.attempts = [{ ...incomplete, ownerSubject: TECH.sub }]; }],
    ['Sent without the archive hash', d => { d.attempts = [{ ...sent, archiveSha256: null }]; }],
    ['a partial object with a full hash', d => { d.attempts = [{ ...incomplete, objects: [sent.objects[0], { ...sent.objects[1], complete: false }] }]; }],
    ['a checkpoint of another object', d => { d.attempts = [{ ...incomplete, objects: [{ ...sent.objects[1] }] }]; }],
    ['an end time that does not exist', d => { d.attempts = [{ ...incomplete, endedAt: '2026-02-30T00:00:00.000Z' }]; }],
    ['a status other than the last attempt', (d, row) => { d.attempts = [incomplete]; row.status = 'prepared'; }],
  ];
  for (const [name, corrupt] of corruptions) {
    const id = randomUUID();
    assert.equal((await prepare(h, study, id)).status, 200, name);
    const row = h.s.ops.get(id);
    corrupt(row.download, row);
    if (name !== 'a status other than the last attempt') row.status = row.download.attempts?.at(-1)?.state ?? 'prepared';
    const before = h.s.op(id), audited = h.s.audits.length;
    for (const [what, call] of [['archive', () => h.request('GET', archivePath(study, id), { as: RAD })],
      ['status', () => h.request('GET', `/api/studies/${study}/original-downloads/${id}`, { as: RAD })], ['replay', () => prepare(h, study, id)]]) {
      const r = await call();
      assert.deepEqual([r.status, r.body?.code, r.bytes.length > 0 && r.headers['content-type'] === 'application/zip'], [503, 'MANIFEST_STORE_INVALID', false], `${name}: ${what}`);
    }
    assert.deepEqual([h.s.op(id), h.s.audits.length], [before, audited], name + ': the row is left exactly as it is, no attempt, no audit');
  }
});

test('S9U4-B37 stored import results and reservations outside their persisted format are a safe 503 IMPORT_STORAGE_UNAVAILABLE with no Orthanc write and no rebuild; a holder that names no attempt of its study is one; a recovery date that does not exist is 400 with nothing changed', async () => {
  const study = uid(), series = study + '.1';
  const corruptEntries = [
    ['an extra key', e => { e.unlisted = 1; }],
    ['a missing key', e => { delete e.identity; }],
    ['a JSON null hash', e => { e.sha256 = null; }],
    ['a date that does not exist', e => { e.at = '2026-02-30T00:00:00.000Z'; }],
    ['a generation out of order', e => { e.attempts[0].generation = 2; }],
    ['an attempt id that is not a UUID', e => { e.attempts[0].attemptId = 'attempt-1'; }],
    ['a code of another outcome', e => { e.code = 'IMPORT_UNCONFIRMED'; }],
    ['an attempt still running under a final result', e => { e.attempts[0].phase = 'dispatching'; e.attempts[0].finishedAt = null; }],
  ];
  for (const [name, corrupt] of corruptEntries) {
    const h = await harness();
    const bytes = dicom({ study, series, id: 'SYN-F' });
    const first = await h.send(bytes);
    assert.equal(first.status, 200, name);
    corrupt(h.s.ops.get(first.id).results[0]);
    const before = h.s.op(first.id), calls = h.orthanc.calls.length;
    const replay = await h.send(bytes, { id: first.id });
    assert.deepEqual([replay.status, replay.body.code], [503, 'IMPORT_STORAGE_UNAVAILABLE'], name + ': POST');
    const status = await h.request('GET', '/api/dicom-import/' + first.id);
    assert.deepEqual([status.status, status.body.code], [503, 'IMPORT_STORAGE_UNAVAILABLE'], name + ': GET');
    assert.deepEqual(h.s.op(first.id), before, name + ': left as it is');
    assert.deepEqual(h.orthanc.calls.slice(calls).filter(c => c.path !== '/system').length, 0, name + ': no Orthanc call beyond readiness');
  }
  // Two entries with one index.
  {
    const h = await harness();
    const id = randomUUID();
    assert.equal((await h.send(dicom({ study, series, id: 'SYN-F' }), { id, index: 0 })).status, 200);
    assert.equal((await h.send(dicom({ study, series, id: 'SYN-F' }), { id, index: 1 })).status, 200);
    h.s.ops.get(id).results[1].index = 0;
    assert.deepEqual((await h.send(dicom({ study, series, id: 'SYN-F' }), { id, index: 2 })).body.code, 'IMPORT_STORAGE_UNAVAILABLE', 'duplicate index');
  }
  const corruptClaims = [
    ['an extra key', c => { c.claim.unlisted = 1; }],
    ['a JSON null PatientID in a bound claim', c => { c.claim.patientId = null; }],
    ['a holder that is not a UUID', c => { c.claim.heldByAttemptId = 'attempt-1'; }],
    ['the claim of another study under this key', c => { c.claim.studyUid = '2.25.999'; }],
    ['a creation date that does not exist', c => { c.claim.createdAt = '2026-02-30T00:00:00.000Z'; }],
    ['a holder that names no attempt', c => { c.claim.heldByAttemptId = randomUUID(); }],
  ];
  for (const [name, corrupt] of corruptClaims) {
    const h = await harness();
    assert.equal((await h.send(dicom({ study, series, id: 'SYN-F' }))).status, 200, name);
    const row = [...h.s.ops.values()].find(r => r.claimKey === 'study:' + study);
    corrupt(row);
    const before = h.s.claim('study:' + study), posts0 = posts(h.orthanc), calls = h.orthanc.calls.length;
    const next = await h.send(dicom({ study, series, id: 'SYN-F' }));
    assert.deepEqual([next.status, next.body.code], [503, 'IMPORT_STORAGE_UNAVAILABLE'], name);
    assert.deepEqual([h.s.claim('study:' + study), posts(h.orthanc)], [before, posts0], name + ': the claim is left as it is; no write');
    assert.equal(h.orthanc.calls.slice(calls).filter(c => c.path !== '/system').length, 0, name + ': refused before any Orthanc read');
  }
  // A holder that is an attempt of another study.
  {
    const h = await harness();
    const other = uid();
    const elsewhere = await unknownAttempt(h, { study: other });
    assert.equal((await h.send(dicom({ study, series, id: 'SYN-F' }))).status, 200);
    [...h.s.ops.values()].find(r => r.claimKey === 'study:' + study).claim.heldByAttemptId = elsewhere.attempt.attemptId;
    assert.deepEqual((await h.send(dicom({ study, series, id: 'SYN-F' }))).body.code, 'IMPORT_STORAGE_UNAVAILABLE', 'a holder of another study');
  }
  // ASTRA-EXTRA-04: a recovery date that does not exist (30 February) is 400 RECOVERY_EVIDENCE_INVALID and changes nothing.
  {
    const h = await harness();
    const a = await unknownAttempt(h);
    h.s.advance(31000);
    h.s.ops.get(a.id).results[0].attempts[0].startedAt = '2026-02-01T00:00:00.000Z';
    const before = h.s.op(a.id), audited = h.s.audits.length;
    for (const checkedAt of ['2026-02-30T00:00:00.000Z', '2026-04-31T00:00:00Z', '2026-13-01T00:00:00.000Z', '2026-02-28T24:00:00.000Z']) {
      const r = await recovery(h, a.id, { basis: 'orthanc-log-checked', checkedAt });
      assert.deepEqual([r.status, r.body.code], [400, 'RECOVERY_EVIDENCE_INVALID'], checkedAt);
    }
    assert.deepEqual([h.s.op(a.id), h.s.audits.length], [before, audited], 'nothing changed');
    const valid = await recovery(h, a.id, { basis: 'orthanc-log-checked', checkedAt: '2026-02-28T00:00:00Z' });
    assert.equal(valid.status, 200, 'a real date in the same form is taken');
    // The body is judged before the file's state: on a file no recovery applies to any more, a real date is 409 and the
    // impossible one is still 400 (an invalid request never reaches the state decision).
    const settled = await recovery(h, a.id, { basis: 'orthanc-log-checked', checkedAt: '2026-02-28T00:00:00Z' });
    assert.deepEqual([settled.status, settled.body.code], [409, 'RECOVERY_NOT_APPLICABLE']);
    const impossible = await recovery(h, a.id, { basis: 'orthanc-log-checked', checkedAt: '2026-02-30T00:00:00.000Z' });
    assert.deepEqual([impossible.status, impossible.body.code], [400, 'RECOVERY_EVIDENCE_INVALID']);
  }
});

test('S9U4-B38 preparation reads the originals twice and compares every value; a change between the readings or a size that is not a number is MANIFEST_INCOMPLETE; at the archive any change of the prepared set, an emptied study included, is MANIFEST_CHANGED with no attempt and byte 0', async () => {
  const noRow = (h, id, name) => assert.deepEqual([h.s.op(id), audits(h.s, 'original.download.prepare').filter(a => a.detail.operationId === id).length], [null, 0], name);
  // ASTRA-09: an original's bytes (and so its MD5) change between the two readings.
  {
    const h = await harness();
    const study = await downloadStudy(h, 1), id = randomUUID();
    const instance = [...h.orthanc.instances.values()][0];
    let enumerations = 0;
    h.orthanc.fault = call => { if (call.path === '/tools/find' && ++enumerations === 2) instance.bytes = Buffer.from(instance.bytes).fill(0x42, instance.bytes.length - 2); return null; };
    const r = await prepare(h, study, id);
    assert.deepEqual([r.status, r.body.code], [409, 'MANIFEST_INCOMPLETE'], 'bytes/MD5 changed between the readings');
    noRow(h, id, 'ASTRA-09');
  }
  // A UID, a size or an instance that changes between the readings.
  for (const [name, fault] of [
    ['a series UID', (count, call) => (call.path.endsWith('/simplified-tags') && count.tags++ === 1 ? 'series' : null)],
    ['a size', (count, call) => (call.path.endsWith('/attachments/dicom/info') && count.info++ === 1 ? 'size' : null)],
    ['an added instance', (count, call) => (call.path === '/tools/find' && count.find++ === 1 ? 'added' : null)],
  ]) {
    const h = await harness();
    const study = await downloadStudy(h, 1), id = randomUUID();
    const [instance] = [...h.orthanc.instances.values()];
    const count = { tags: 0, info: 0, find: 0 };
    h.orthanc.fault = call => {
      const what = fault(count, call);
      if (what === 'series') return { raw: JSON.stringify({ PatientID: 'SYN-D', StudyInstanceUID: study, SeriesInstanceUID: study + '.9', SOPInstanceUID: instance.h.sopInstanceUid }) };
      if (what === 'size') return { raw: JSON.stringify({ UncompressedSize: instance.bytes.length + 1, UncompressedMD5: md5(instance.bytes) }) };
      if (what === 'added') return { raw: JSON.stringify([instance.id, '00000000-00000000-00000000-00000000-00000001']) };
      return null;
    };
    const r = await prepare(h, study, id);
    assert.deepEqual([r.status, r.body.code], [409, 'MANIFEST_INCOMPLETE'], name);
    noRow(h, id, name);
  }
  // Sizes outside Orthanc's own forms are refused, never coerced (ASTRA-EXTRA-03 null); a number and its digits are taken.
  for (const [size, accepted] of [[null, false], [true, false], ['', false], ['-1', false], ['1.5', false], ['007', false], [{}, false], [-1, false], [1.5, false], ['number', true], ['digits', true]]) {
    const h = await harness();
    const study = await downloadStudy(h, 1), id = randomUUID();
    const [instance] = [...h.orthanc.instances.values()];
    const value = size === 'number' ? instance.bytes.length : size === 'digits' ? String(instance.bytes.length) : size;
    h.orthanc.fault = call => (call.path.endsWith('/attachments/dicom/info') ? { raw: JSON.stringify({ UncompressedSize: value, UncompressedMD5: md5(instance.bytes) }) } : null);
    const r = await prepare(h, study, id);
    if (accepted) assert.deepEqual([r.status, r.body.state], [200, 'prepared'], JSON.stringify(size));
    else { assert.deepEqual([r.status, r.body.code], [409, 'MANIFEST_INCOMPLETE'], JSON.stringify(size)); noRow(h, id, JSON.stringify(size)); }
  }
  // Order alone may differ between the readings and at the archive.
  {
    const h = await harness();
    const study = await downloadStudy(h, 3), id = randomUUID();
    let finds = 0;
    h.orthanc.fault = call => {
      if (call.path !== '/tools/find' || ++finds === 1) return null;
      return { raw: JSON.stringify([...h.orthanc.instances.values()].filter(i => i.h.studyInstanceUid === study).map(i => i.id).reverse()) };
    };
    assert.deepEqual((await prepare(h, study, id)).body.state, 'prepared', 'reversed second reading');
    const zip = await h.request('GET', archivePath(study, id), { as: RAD });
    assert.equal(zip.bytes.length, Number(zip.headers['content-length']), 'reversed enumeration at the archive');
  }
  // At the archive: an emptied study (ASTRA-EXTRA-02), a changed MD5 or an added instance is MANIFEST_CHANGED; a read
  // failure is MANIFEST_INCOMPLETE; never an attempt, an intent row or a byte.
  for (const [name, change, code] of [
    ['emptied', h => h.orthanc.instances.clear(), 'MANIFEST_CHANGED'],
    ['MD5 changed', h => { h.orthanc.fault = call => (call.path.endsWith('/attachments/dicom/info') ? { raw: JSON.stringify({ UncompressedSize: 1, UncompressedMD5: '0'.repeat(32) }) } : null); }, 'MANIFEST_CHANGED'],
    ['an instance added', (h, study) => h.orthanc.store(dicom({ study, series: study + '.1', id: 'SYN-D', pixel: 200 })), 'MANIFEST_CHANGED'],
    ['an enumeration failure', h => { h.orthanc.fault = call => (call.path === '/tools/find' ? { status: 500 } : null); }, 'MANIFEST_INCOMPLETE'],
    ['a tags failure', h => { h.orthanc.fault = call => (call.path.endsWith('/simplified-tags') ? { status: 500 } : null); }, 'MANIFEST_INCOMPLETE'],
  ]) {
    const h = await harness();
    const study = await downloadStudy(h, 2), id = randomUUID();
    assert.equal((await prepare(h, study, id)).status, 200);
    change(h, study);
    const r = await h.request('GET', archivePath(study, id), { as: RAD });
    assert.deepEqual([r.status, r.body?.code], [409, code], name);
    assert.deepEqual([h.s.op(id).download.attempts.length, audits(h.s, 'original.download.intent').length], [0, 0], name + ': no attempt');
  }
});

test('S9U4-B39 an expired sending attempt is closed Unconfirmed with exactly one result row by whichever path comes first (GET, startup, the next archive); a result row that cannot be written leaves it open and starts nothing', async () => {
  const expiredAttempt = (h, id) => {
    const row = h.s.ops.get(id);
    const attempt = { attemptId: randomUUID(), number: 1, ownerSubject: RAD.sub, actor: 'earlier@synthetic.test', manifestSha256: row.manifestSha256,
      destination: 'browser-download', state: 'sending', startedAt: new Date(T0 - 60000).toISOString(), endedAt: null, ownerInstance: randomUUID(),
      leaseUntil: new Date(T0 - 1000).toISOString(), objects: [], archiveSha256: null, responseFinished: false };
    row.download.attempts.push(attempt);
    row.status = 'sending';
    return attempt;
  };
  for (const first of ['GET', 'startup', 'archive']) {
    const h = await harness();
    const study = await downloadStudy(h, 1), id = randomUUID();
    assert.equal((await prepare(h, study, id)).status, 200);
    const attempt = expiredAttempt(h, id);
    const paths = { GET: () => h.request('GET', `/api/studies/${study}/original-downloads/${id}`, { as: RAD }),
      startup: () => h.transfer.expireDownloads(), archive: () => h.request('GET', archivePath(study, id), { as: RAD }) };
    await paths[first]();
    for (const other of Object.keys(paths).filter(p => p !== first && p !== 'archive')) await paths[other]();
    await sleep(50);
    const [closed] = h.s.op(id).download.attempts;
    assert.deepEqual([closed.state, closed.endedAt !== null, closed.objects], ['unconfirmed', true, []], first);
    const rows = resultRows(h, attempt.attemptId);
    assert.deepEqual(rows.map(x => [x.actor, x.detail.state, x.detail.reason, x.detail.institutionId, x.detail.responseFinished]),
      [['earlier@synthetic.test', 'unconfirmed', 'lease-expired', 'inst-a', false]], first + ': exactly one result row for that attempt');
    if (first === 'archive') {
      const attempts = h.s.op(id).download.attempts;
      assert.deepEqual(attempts.map(a => a.state), ['unconfirmed', 'sent']);
      assert.deepEqual(audits(h.s, 'original.download.intent').map(a => a.detail.attemptId), [attempts[1].attemptId], 'the new attempt has its own intent');
      assert.deepEqual(resultRows(h, attempts[1].attemptId).map(x => x.detail.state), ['sent'], 'and its own result');
    }
  }
  // The result row cannot be written: the attempt stays as committed (sending), no path reports it closed, no new attempt.
  const h = await harness();
  const study = await downloadStudy(h, 1), id = randomUUID();
  assert.equal((await prepare(h, study, id)).status, 200);
  expiredAttempt(h, id);
  h.s.auditFailure = data => data.action === 'original.download.result';
  const status = await h.request('GET', `/api/studies/${study}/original-downloads/${id}`, { as: RAD });
  assert.deepEqual([status.status, status.body.state], [200, 'sending'], 'never shown closed without its result row');
  assert.equal(await h.transfer.expireDownloads(), 0);
  const archive = await h.request('GET', archivePath(study, id), { as: RAD });
  assert.deepEqual([archive.status, archive.body.code], [503, 'IMPORT_STORAGE_UNAVAILABLE']);
  assert.deepEqual([h.s.op(id).download.attempts.map(a => a.state), audits(h.s, 'original.download.intent').length], [['sending'], 0]);
  h.s.auditFailure = null;
  assert.equal(await h.transfer.expireDownloads(), 1);
  assert.equal(h.s.op(id).status, 'unconfirmed');
});
// ── the gate findings of round 2: status access (U4BB-01), the credential before the write (U4BB-02), one transition table
// by DB time (U4BB-04), one automatic re-check (U4BB-05), the recovery CAS (U4BB-06), the known context of a result
// (U4BB-11), the creation race of an operation id (U4BB-12) and storage failures before any intent (U4BB-16) ──

const allowPolicy = study => ({ institution: 'inst-a', policy: { version: 1, restricted: true, startsAt: null, endsAt: null,
  rules: [{ patientId: null, modalities: [], dateFrom: null, dateTo: null, studyUids: [study] }] } });
/** A gate that holds the first statement matching `when` until open() (the others pass). */
function holdOnce(h, when) {
  let open, reached;
  const gate = new Promise(resolve => { open = resolve; });
  const seen = new Promise(resolve => { reached = resolve; });
  let used = false;
  h.s.onQuery = async (sql, values, tx) => { if (!used && when(sql, values, tx)) { used = true; reached(); await gate; } };
  return { open: () => { h.s.onQuery = null; open(); }, reached: seen };
}

test('S9U4-B40 status GETs check the role, the institution, the study ownership and StudyAccess now (ASTRA-01): a policy restricted before the import, a study moved or tele-received, a multi-study operation with one study out of reach - one 404 with nothing of it; a renamed actor and restored rights see the result again', async () => {
  const h = await harness();
  const study = uid(), other = uid();
  // A restricted account whose policy (set before the import) covers the study: import and status both answer.
  h.s.policies.set(TECH.sub, allowPolicy(study));
  own(h.s, study, 'inst-a', 'gateway');
  const first = await h.send(dicom({ study }));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const ok = await h.request('GET', '/api/dicom-import/' + first.id);
  assert.deepEqual([ok.status, ok.body.files[0].outcome], [200, 'stored']);
  // The policy narrowed to another study: the same 404 as an unknown operation, nothing of the file in it.
  h.s.policies.set(TECH.sub, deniedPolicy);
  const narrowed = await h.request('GET', '/api/dicom-import/' + first.id);
  assert.deepEqual([narrowed.status, narrowed.body.message], [404, '반입 작업을 찾을 수 없습니다']);
  noPatientValue(narrowed.body, study, first.body.sopUid, first.body.sha256);
  assert.deepEqual((await h.request('GET', '/api/dicom-import/' + randomUUID())).body, narrowed.body, 'identical to an absent operation');
  // Restored rights: the same result again; a renamed actor of the same subject too.
  h.s.policies.delete(TECH.sub);
  assert.equal((await h.request('GET', '/api/dicom-import/' + first.id)).status, 200);
  assert.equal((await h.request('GET', '/api/dicom-import/' + first.id, { as: { ...TECH, actor: 'renamed@synthetic.test' } })).status, 200, 'same sub, renamed actor');
  // The study moved to another institution, then tele-received from it: 404 both times; moved back: 200.
  h.s.states.get(study).institutionId = 'inst-b';
  assert.equal((await h.request('GET', '/api/dicom-import/' + first.id)).status, 404, 'moved');
  h.s.states.get(study).teleInstitutionId = 'inst-a';
  assert.equal((await h.request('GET', '/api/dicom-import/' + first.id)).status, 404, 'tele-received');
  Object.assign(h.s.states.get(study), { institutionId: 'inst-a', teleInstitutionId: null });
  assert.equal((await h.request('GET', '/api/dicom-import/' + first.id)).status, 200, 'back');
  // A multi-study operation: one study out of reach hides the whole operation (no partial answer).
  const multi = randomUUID();
  assert.equal((await h.send(dicom({ study }), { id: multi, index: 0 })).status, 200);
  assert.equal((await h.send(dicom({ study: other }), { id: multi, index: 1 })).status, 200);
  h.s.policies.set(TECH.sub, allowPolicy(study));
  const partial = await h.request('GET', '/api/dicom-import/' + multi);
  assert.equal(partial.status, 404);
  noPatientValue(partial.body, study, other);
  h.s.policies.delete(TECH.sub);
  assert.equal((await h.request('GET', '/api/dicom-import/' + multi)).body.files.length, 2);
  // Results decided from the caller's own file alone (a foreign study's refusal, a modality refusal) need no study check.
  const foreign = uid();
  h.s.states.set(foreign, { uid: foreign, institutionId: 'inst-b', teleInstitutionId: 'inst-a', origin: 'gateway' });
  const refusals = randomUUID();
  assert.equal((await h.send(dicom({ study: foreign }), { id: refusals, index: 0 })).body.code, 'STUDY_OWNERSHIP_CONFLICT');
  assert.equal((await h.send(dicom({ study: foreign, modality: 'MG' }), { id: refusals, index: 1 })).body.code, 'MODALITY_NOT_IMPORTABLE');
  const own404 = await h.request('GET', '/api/dicom-import/' + refusals);
  assert.deepEqual([own404.status, own404.body.files.map(f => f.code)], [200, ['STUDY_OWNERSHIP_CONFLICT', 'MODALITY_NOT_IMPORTABLE']]);
  // The download status: StudyAccess and the institution now, else the same 404 as no operation (ASTRA-01).
  const dl = await downloadStudy(h, 1), id = randomUUID();
  assert.equal((await prepare(h, dl, id)).status, 200);
  const status = () => h.request('GET', `/api/studies/${dl}/original-downloads/${id}`, { as: RAD });
  h.s.policies.set(RAD.sub, deniedPolicy);
  assert.deepEqual([(await status()).status, (await status()).body.message], [404, '다운로드 작업을 찾을 수 없습니다']);
  h.s.policies.delete(RAD.sub);
  h.s.states.get(dl).institutionId = 'inst-b';
  assert.equal((await status()).status, 404, 'moved');
  h.s.states.get(dl).institutionId = 'inst-a';
  assert.equal((await status()).status, 200, 'restored');
});

test('S9U4-B41 the credential of the request is checked again right before the write (ASTRA-02): a logout, an ended provider session or an expired token - also during a long legacy initialisation - is 403 without a code, no POST /instances, IMPORT_PERMISSION_REVOKED certain-no-write with its own holders released; a credential check that fails for another reason is 503 and writes nothing', async () => {
  const cases = [
    ['logout of the cookie session', { ...TECH, session: 'sid-tech-a' }, h => h.s.sessions.delete('sid-tech-a')],
    ['provider session ended', TECH, h => h.s.idpEnded.add('idp:' + TECH.sub)],
    ['access token expired', TECH, h => h.s.expiredTokens.add('tok:' + TECH.sub)],
  ];
  for (const [name, as, end] of cases) {
    const h = await harness();
    h.s.sessions.add('sid-tech-a');
    const study = uid();
    h.orthanc.fault = call => { if (call.path === '/tools/lookup') end(h); return null; };
    const r = await h.send(dicom({ study }), { as });
    assert.deepEqual([r.status, r.body.code, r.body.message], [403, undefined, '인증 세션이 없습니다'], name);
    const entry = h.s.file(r.id, 0);
    assert.deepEqual([entry.outcome, entry.code, entry.attempts[0].phase, entry.attempts[0].transport], ['retryable', 'IMPORT_PERMISSION_REVOKED', 'finished', 'certain-no-write'], name);
    assert.deepEqual([posts(h.orthanc), h.s.claim('study:' + study).claim.heldByAttemptId, h.s.claim('sop:' + entry.sopUid).claim.heldByAttemptId], [0, null, null], name);
  }
  // A logout while a long legacy initialisation reads its headers: refused at the check before the write.
  {
    const h = await harness();
    h.s.sessions.add('sid-tech-a');
    const study = uid();
    h.orthanc.store(dicom({ study, series: study + '.1', id: 'SYN-L' }));
    own(h.s, study);
    let release;
    const held = new Promise(resolve => { release = resolve; });
    h.orthanc.fault = async call => (call.path.endsWith('?simplify') ? (await held, null) : null);
    const pending = h.send(dicom({ study, series: study + '.2', id: 'SYN-L' }), { as: { ...TECH, session: 'sid-tech-a' } });
    await sleep(150);
    h.s.sessions.delete('sid-tech-a');
    release();
    const r = await pending;
    assert.deepEqual([r.status, h.s.file(r.id, 0).code, posts(h.orthanc)], [403, 'IMPORT_PERMISSION_REVOKED', 0]);
    assert.deepEqual([h.s.claim('study:' + study).claim.phase, h.s.claim('study:' + study).claim.heldByAttemptId], ['bound', null], 'the binding stays, the holder goes');
  }
  // Positive control: the session alive -> stored.
  {
    const h = await harness();
    h.s.sessions.add('sid-tech-a');
    assert.equal((await h.send(dicom({ study: uid() }), { as: { ...TECH, session: 'sid-tech-a' } })).status, 200);
  }
  // A credential check that cannot answer (storage, provider): 503 IMPORT_STORAGE_UNAVAILABLE, no write, never a session end.
  {
    const h = await harness();
    h.orthanc.fault = call => { if (call.path === '/tools/lookup') h.s.authFailure = () => new common.ServiceUnavailableException({ code: 'AUTH_IDP_UNAVAILABLE' }); return null; };
    const r = await h.send(dicom({ study: uid() }));
    h.s.authFailure = null;
    assert.deepEqual([r.status, r.body.code, posts(h.orthanc)], [503, 'IMPORT_STORAGE_UNAVAILABLE', 0]);
    assert.equal(h.s.file(r.id, 0).attempts[0].phase, 'prepared', 'nothing decided: the attempt runs out and is fenced like any other');
  }
});

test('S9U4-B42 one transition table by DB time: an initialising worker whose lease ran out never binds or writes (ASTRA-04); a dispatched worker whose lease ran out writes no result (ASTRA-05); a renewal waits for the claim lock and never revives an expired lease; unknown is untouched until its lease ends (ASTRA-08)', async t => {
  // ASTRA-04: the DB clock passes the lease while the initialisation reads headers: no bind, no POST, IMPORT_ATTEMPT_EXPIRED.
  {
    const h = await harness();
    const study = uid(); own(h.s, study);
    h.orthanc.store(dicom({ study }));
    let moved = false;
    h.orthanc.fault = call => { if (!moved && call.path.endsWith('/tags?simplify')) { moved = true; h.s.advance(31000); } return null; };
    const r = await h.send(dicom({ study }));
    assert.deepEqual([r.status, r.body.outcome, r.body.code, posts(h.orthanc)], [200, 'retryable', 'IMPORT_ATTEMPT_EXPIRED', 0]);
    assert.equal(h.s.claim('study:' + study), null, 'the initializing claim goes; the next import reads again');
    const [a] = h.s.file(r.id, 0).attempts;
    assert.deepEqual(audits(h.s, 'dicom.import.result').filter(x => x.detail.attemptId === a.attemptId).map(x => x.detail.code), ['IMPORT_ATTEMPT_EXPIRED']);
  }
  // ASTRA-05: the DB clock passes the lease after the POST: the late worker writes no result and keeps the holders; once
  // the lease ended a GET reconciles it read-only (one object, no second write).
  {
    const h = await harness();
    const study = uid();
    h.orthanc.onPost = () => { h.s.advance(31000); h.orthanc.onPost = null; };
    const r = await h.send(dicom({ study }));
    assert.deepEqual([r.status, r.body.outcome], [202, 'unconfirmed']);
    const [a] = h.s.file(r.id, 0).attempts;
    assert.deepEqual([a.phase, h.s.claim('study:' + study).claim.heldByAttemptId], ['dispatching', a.attemptId], 'no result written, holders kept');
    const status = await h.request('GET', '/api/dicom-import/' + r.id);
    assert.deepEqual([status.body.files[0].outcome, posts(h.orthanc), h.s.claim('study:' + study).claim.heldByAttemptId], ['stored', 1, null]);
  }
  // A renewal in claim -> operation order with the time after its locks: it waits for a claim lock another transaction
  // holds while the DB clock passes the lease, and then refuses to revive it (the lookup the worker waits on is held).
  {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const h = await harness();
    const study = uid(), bytes = dicom({ study });
    h.orthanc.fault = call => (call.path === '/tools/lookup' ? { hang: true } : null);
    const pending = h.send(bytes);
    await sleep(150);
    const id = [...h.s.ops.values()].find(o => o.kind === 'import').id;
    const before = h.s.file(id, 0).attempts[0].leaseUntil;
    let unlock, locked;
    const holding = new Promise(resolve => { unlock = resolve; });
    const isLocked = new Promise(resolve => { locked = resolve; });
    const other = h.s.prisma.$transaction(async tx => {
      await tx.$executeRaw(['SELECT pg_advisory_xact_lock(', '::bigint)'], 'study-claim-held-by-test');
      await tx.$queryRaw(['SELECT * FROM "ImportOperation" WHERE "claimKey" = ', ' FOR UPDATE'], 'study:' + study);
      locked();
      await holding;
    }, { isolationLevel: 'ReadCommitted', maxWait: 4000, timeout: 8000 });
    await isLocked;
    // The DB clock moves 5 s first, so a renewal that did not wait for the claim lock would visibly move the lease (to
    // DB now + 30 s); the one that waits reads the time only after its locks, when the lease has already ended.
    try {
      h.s.advance(5000);
      t.mock.timers.tick(10000);
      await sleep(50);
      assert.equal(h.s.file(id, 0).attempts[0].leaseUntil, before, 'the renewal waits behind the claim lock');
      h.s.advance(26000);
    } finally {
      unlock();   // the test's own transaction ends whatever happened, so a failure never holds the file open
    }
    await other;
    await sleep(100);
    assert.ok(Date.parse(before) < h.s.clock, 'the lease has ended by DB time');
    assert.equal(h.s.file(id, 0).attempts[0].leaseUntil, before, 'an expired lease is never revived');
    h.orthanc.fault = null;
    void pending;
  }
  // ASTRA-08: an unknown attempt with 28 s of lease left: the same POST, a GET and the admin recovery all leave it alone.
  {
    const h = await harness();
    const a = await unknownAttempt(h);
    h.s.advance(2000);
    h.orthanc.calls.length = 0;
    assert.equal((await h.send(a.bytes, { id: a.id })).status, 202);
    assert.equal((await h.request('GET', '/api/dicom-import/' + a.id)).body.files[0].outcome, 'unconfirmed');
    assert.equal((await recovery(h, a.id, { basis: 'orthanc-restarted', checkedAt: new Date(T0 + 1000).toISOString() })).body.code, 'RECOVERY_NOT_APPLICABLE');
    assert.deepEqual([h.orthanc.calls.filter(c => c.path === '/tools/lookup').length, h.s.file(a.id, 0).attempts[0].autoRecheckedAt], [0, null]);
  }
});

test('S9U4-B43 the automatic re-check runs once per attempt even for overlapping same-key POSTs (ASTRA-07): its reading right is taken with the row before the lookup; an absence is recorded once; a stopped reader keeps the holders and its right runs out', async () => {
  const h = await harness();
  const a = await unknownAttempt(h);
  h.s.advance(31000);
  h.orthanc.calls.length = 0;
  h.orthanc.fault = async call => { if (call.path === '/tools/lookup') await sleep(150); return null; };
  const answers = await Promise.all([h.send(a.bytes, { id: a.id }), h.send(a.bytes, { id: a.id })]);
  assert.deepEqual(answers.map(r => r.status), [202, 202]);
  assert.equal(h.orthanc.calls.filter(c => c.path === '/tools/lookup').length, 1, 'one bounded lookup for two overlapping POSTs');
  const [attempt] = h.s.file(a.id, 0).attempts;
  assert.ok(attempt.autoRecheckedAt);
  assert.deepEqual(audits(h.s, 'dicom.import.result').filter(x => x.detail.attemptId === attempt.attemptId).map(x => x.detail.outcome), ['unconfirmed', 'unconfirmed'],
    'the unknown result row, then the re-check absence once');
  h.orthanc.fault = null;
  h.orthanc.calls.length = 0;
  assert.equal((await h.send(a.bytes, { id: a.id })).status, 202);
  assert.deepEqual([h.orthanc.calls.filter(c => c.path !== '/system').length, posts(h.orthanc)], [0, 0], 'no second read, no resend');
  // A reader that stops after taking its right (the lookup never answers): the holders stay; the right runs out and the
  // next POST re-checks once.
  const h2 = await harness();
  const b = await unknownAttempt(h2);
  h2.s.advance(31000);
  h2.orthanc.fault = call => (call.path === '/tools/lookup' ? { hang: true } : null);
  const stalled = h2.send(b.bytes, { id: b.id });
  await sleep(150);
  assert.equal(h2.s.claim('study:' + b.study).claim.heldByAttemptId, b.attempt.attemptId);
  assert.equal((await h2.send(b.bytes, { id: b.id })).status, 202, 'the reading right is held: nothing read');
  h2.orthanc.fault = null;
  await stalled;
  h2.s.advance(31000);
  assert.equal((await h2.send(b.bytes, { id: b.id })).status, 202);
  assert.ok(h2.s.file(b.id, 0).attempts[0].autoRecheckedAt);
  assert.equal(h2.s.claim('study:' + b.study).claim.heldByAttemptId, b.attempt.attemptId, 'absence never releases the occupancy');
});

test('S9U4-B44 the admin recovery re-reads Orthanc for both kinds and commits only on the state it read (ASTRA-06, ASTRA-13): a failed read is 503 with nothing changed; a reconciliation or another admin that won meanwhile makes it 409; two admins in one DB millisecond never mix; a failing result row rolls everything back', async () => {
  const body = (checkedAt = new Date(T0 + 1000).toISOString()) => ({ basis: 'orthanc-log-checked', checkedAt });
  async function mayHaveWritten(h) {
    const study = uid(), sop = uid();
    h.orthanc.onPost = (stored, o) => { o.store(dicom({ study, series: study + '.1', sop, id: 'SYN-OUTSIDE' })); o.onPost = null; };
    const r = await h.send(dicom({ study, series: study + '.1', sop }));
    assert.equal(r.body.writeDisposition, 'may-have-written');
    h.s.advance(5000);
    return { id: r.id, study };
  }
  // ASTRA-06: a may-have-written occupancy and a failing lookup: 503 ORTHANC_UNAVAILABLE, the lookup was asked, nothing released.
  {
    const h = await harness();
    const m = await mayHaveWritten(h);
    const before = h.s.file(m.id, 0);
    h.orthanc.calls.length = 0;
    h.orthanc.fault = call => (call.path === '/tools/lookup' ? { status: 500 } : null);
    const r = await recovery(h, m.id, body());
    assert.deepEqual([r.status, r.body.code], [503, 'ORTHANC_UNAVAILABLE']);
    assert.ok(h.orthanc.calls.some(c => c.path === '/tools/lookup'), 'the bounded re-read ran');
    assert.deepEqual([h.s.file(m.id, 0).outcome, h.s.file(m.id, 0).code, h.s.claim('study:' + m.study).claim.heldByAttemptId], [before.outcome, before.code, before.attempts[0].attemptId]);
    h.orthanc.fault = null;
    const done = await recovery(h, m.id, body());
    assert.deepEqual([done.status, done.body.outcome, h.s.claim('study:' + m.study).claim.heldByAttemptId], [200, 'rejected', null], 'with Orthanc answering: occupancy released, result unchanged');
  }
  // ASTRA-13: the recovery's read is slow and the object lands meanwhile; a GET in between finds the reading right held
  // and reconciles nothing, so no stale answer overwrites a settled file; the resend then finds the object (one object).
  {
    const h = await harness();
    const a = await unknownAttempt(h);
    h.s.advance(31000);
    let release, reached;
    const held = new Promise(resolve => { release = resolve; });
    const seen = new Promise(resolve => { reached = resolve; });
    let first = true;
    h.orthanc.fault = async call => { if (call.path === '/tools/lookup' && first) { first = false; reached(); await held; return { raw: '[]' }; } return null; };
    const pending = recovery(h, a.id, body());
    await seen;
    h.orthanc.store(a.bytes);
    const status = await h.request('GET', '/api/dicom-import/' + a.id);
    assert.equal(status.body.files[0].outcome, 'unconfirmed', 'the GET does not read while the recovery holds the reading right');
    release();
    const recovered = await pending;
    assert.deepEqual([recovered.status, recovered.body.code], [200, 'RECOVERED_NO_OBJECT']);
    const resent = await h.send(a.bytes, { id: a.id });
    assert.deepEqual([resent.status, resent.body.outcome, h.orthanc.count()], [200, 'already-present', 1]);
  }
  // A reconciliation that holds the right first: the recovery is 409 while it runs and 409 once the file is settled.
  {
    const h = await harness();
    const a = await unknownAttempt(h, { stored: true });
    h.s.advance(31000);
    let release, reached;
    const held = new Promise(resolve => { release = resolve; });
    const seen = new Promise(resolve => { reached = resolve; });
    h.orthanc.fault = async call => { if (call.path === '/tools/lookup') { reached(); await held; } return null; };
    const get = h.request('GET', '/api/dicom-import/' + a.id);
    await seen;
    assert.equal((await recovery(h, a.id, body())).body.code, 'RECOVERY_NOT_APPLICABLE', 'in progress');
    h.orthanc.fault = null;
    release();
    assert.equal((await get).body.files[0].outcome, 'stored');
    assert.equal((await recovery(h, a.id, body())).body.code, 'RECOVERY_NOT_APPLICABLE', 'settled');
    assert.equal(audits(h.s, 'dicom.import.recovery.result').length, 0);
  }
  // Two admins within one DB millisecond on one may-have-written occupancy: the later request record wins; the earlier
  // request is 409 with nothing of it in the result; each request row keeps its own admin.
  {
    const h = await harness();
    const m = await mayHaveWritten(h);
    let release, arrived = 0, both;
    const held = new Promise(resolve => { release = resolve; });
    const two = new Promise(resolve => { both = resolve; });
    h.orthanc.fault = async call => { if (call.path === '/tools/lookup') { if (++arrived === 2) both(); await held; } return null; };
    const first = recovery(h, m.id, body(new Date(T0 + 1000).toISOString()), ADMIN);
    await sleep(100);
    const second = recovery(h, m.id, { basis: 'orthanc-restarted', checkedAt: new Date(T0 + 2000).toISOString() }, ADMIN2);
    await two;
    release();
    const answers = [await first, await second];
    assert.deepEqual(answers.map(r => [r.status, r.status === 200 ? r.body.outcome : r.body.code]), [[409, 'RECOVERY_NOT_APPLICABLE'], [200, 'rejected']]);
    assert.deepEqual(audits(h.s, 'dicom.import.recovery.request').map(x => [x.actor, x.detail.basis]), [[ADMIN.actor, 'orthanc-log-checked'], [ADMIN2.actor, 'orthanc-restarted']]);
    assert.deepEqual(audits(h.s, 'dicom.import.recovery.result').map(x => [x.actor, x.detail.basis, x.detail.adminSubject]), [[ADMIN2.actor, 'orthanc-restarted', ADMIN2.sub]]);
    assert.deepEqual([h.s.file(m.id, 0).attempts[0].recovery.adminSubject, h.s.file(m.id, 0).attempts[0].recovery.basis], [ADMIN2.sub, 'orthanc-restarted']);
  }
  // An automatic re-check holding the reading right: the recovery is 409 meanwhile; afterwards (absence recorded, right
  // given back) it records its own basis.
  {
    const h = await harness();
    const a = await unknownAttempt(h);
    h.s.advance(31000);
    let release, reached;
    const held = new Promise(resolve => { release = resolve; });
    const seen = new Promise(resolve => { reached = resolve; });
    h.orthanc.fault = async call => { if (call.path === '/tools/lookup') { reached(); await held; } return null; };
    const recheck = h.send(a.bytes, { id: a.id });
    await seen;
    assert.equal((await recovery(h, a.id, body())).body.code, 'RECOVERY_NOT_APPLICABLE', 'the re-check reads');
    h.orthanc.fault = null;
    release();
    assert.equal((await recheck).status, 202);
    assert.deepEqual((await recovery(h, a.id, body())).body.code, 'RECOVERED_NO_OBJECT');
  }
  // Two objects under the SOP UID at the recovery read: rejected SOP_UID_AMBIGUOUS may-have-written, occupancy released.
  {
    const h = await harness();
    const a = await unknownAttempt(h, { stored: true });
    const entry = h.s.file(a.id, 0);
    h.orthanc.store(dicom({ study: a.study, series: entry.seriesUid, sop: entry.sopUid, id: 'SYN-SECOND' }));
    h.s.advance(31000);
    const r = await recovery(h, a.id, body());
    assert.deepEqual([r.status, r.body.outcome, r.body.code, r.body.writeDisposition], [200, 'rejected', 'SOP_UID_AMBIGUOUS', 'may-have-written']);
    assert.equal(h.s.claim('study:' + a.study).claim.heldByAttemptId, null);
  }
  // A result row that cannot be written: the whole result rolls back (503, outcome and holders unchanged, no result row);
  // once the reading right ran out the same request succeeds.
  {
    const h = await harness();
    const a = await unknownAttempt(h);
    h.s.advance(31000);
    h.s.auditFailure = data => data.action === 'dicom.import.recovery.result';
    const failed = await recovery(h, a.id, body());
    assert.deepEqual([failed.status, failed.body.code], [503, 'IMPORT_STORAGE_UNAVAILABLE']);
    assert.deepEqual([h.s.file(a.id, 0).outcome, h.s.claim('study:' + a.study).claim.heldByAttemptId, audits(h.s, 'dicom.import.recovery.result').length],
      ['unconfirmed', a.attempt.attemptId, 0]);
    h.s.auditFailure = null;
    h.s.advance(31000);
    assert.deepEqual((await recovery(h, a.id, body())).body.code, 'RECOVERED_NO_OBJECT');
  }
});

test('S9U4-B45 a file result keeps what is already known (ASTRA-12, ASTRA-14): the three UIDs of a parsed file refused for its modality or identity, the Study UID as the audit target, the request actor of a new refusal, and only an InstitutionName mismatch flag (no tag text); the replay keeps the file-specific description', async () => {
  const h = await harness();
  const study = uid(), series = study + '.1';
  const first = await h.send(dicom({ study, series }));
  // ASTRA-12: an MG file of a known study - its UIDs stay with the refusal and its audit row.
  const mg = dicom({ study, series, modality: 'MG' });
  const refused = await h.send(mg, { id: first.id, index: 1, as: { ...TECH, actor: 'renamed@synthetic.test' } });
  assert.deepEqual([refused.body.code, refused.body.studyUid, refused.body.seriesUid, !!refused.body.sopUid], ['MODALITY_NOT_IMPORTABLE', study, series, true]);
  const entry = h.s.file(first.id, 1);
  assert.deepEqual([entry.studyUid, entry.seriesUid, entry.sopUid], [study, series, refused.body.sopUid]);
  const row = audits(h.s, 'dicom.import.result').find(a => a.detail.operationId === first.id && a.detail.index === 1);
  // ASTRA-14: the actor of the request that refused it; the operation keeps its first actor and its owner.
  assert.deepEqual([row.target, row.actor, row.detail.actor], [study, 'renamed@synthetic.test', 'renamed@synthetic.test']);
  assert.deepEqual([h.s.op(first.id).actor, h.s.op(first.id).ownerSubject], [TECH.actor, TECH.sub]);
  // U4BB-18: the same bytes again replay the mammography sentence; GET gives the table's general description.
  const replay = await h.send(mg, { id: first.id, index: 1 });
  assert.equal(replay.body.message, refused.body.message);
  assert.equal(replay.body.message, '유방촬영 영상은 아직 직접 반입할 수 없습니다.');
  const status = await h.request('GET', '/api/dicom-import/' + first.id);
  assert.equal(status.body.files[1].message, '이 종류의 영상은 아직 직접 반입할 수 없습니다.');
  // A file the reader refused has no UIDs and its row targets the operation.
  const unread = await h.send(Buffer.from('not dicom'), { id: first.id, index: 2 });
  assert.deepEqual([unread.body.studyUid, audits(h.s, 'dicom.import.result').find(a => a.detail.index === 2 && a.detail.operationId === first.id).target], [null, first.id]);
  // InstitutionName: the own name or an alias (trim/case) -> false; another hospital's name -> true; no tag -> null.
  for (const [name, flag] of [['  synthetic a ', false], ['SYN A', false], ['inst-a', false], ['SYNTHETIC OTHER HOSPITAL', true], [null, null]]) {
    const r = await h.send(dicom({ study: uid(), institution: name }));
    assert.equal(r.status, 200, String(name));
    const rows = h.s.audits.filter(a => JSON.parse(a.detail).operationId === r.id).map(a => JSON.parse(a.detail));
    assert.deepEqual(rows.map(d => d.institutionNameMismatch), [flag, flag], String(name) + ': intent and result');
    noPatientValue(h.s.audits, 'SYNTHETIC OTHER HOSPITAL');
    noPatientValue(h.s.op(r.id), 'SYNTHETIC OTHER HOSPITAL', 'institutionNameMismatch');
  }
  const flagged = await h.send(dicom({ study: uid(), institution: 'SYNTHETIC OTHER HOSPITAL', modality: 'NM' }));
  assert.equal(JSON.parse(h.s.audits.at(-1).detail).institutionNameMismatch, true, 'a refusal row carries the flag too');
  assert.ok([...h.s.states.values()].every(state => state.institutionId === 'inst-a' && state.origin === 'local-import'), 'the flag never changes ownership');
  void flagged;
});

test('S9U4-B46 two requests creating one new operation id are serialised by its advisory lock, never by a lock on an absent row (ASTRA-PG-ABSENCE): same index and other bytes 409 OPERATION_CONTENT_CONFLICT, other indexes both kept, another owner 409 OPERATION_CONFLICT, an import and a download preparation of one id 409', async () => {
  // The first request is held after its lock on the (still absent) operation row and before it creates the row: only a
  // lock that does not depend on the row existing keeps the second one out of that window.
  const afterOpSelect = id => { let inTx = null; return (sql, values, tx) => {
    if (!inTx && sql.includes('WHERE id = ?::uuid FOR UPDATE') && values[0] === id) { inTx = tx; return false; }
    return !!inTx && tx === inTx && sql.includes('clock_timestamp()');
  }; };
  const ownStudy = h => { const study = uid(); own(h.s, study, 'inst-a', 'gateway'); return study; };
  async function race(h, id, first, second) {
    const hold = holdOnce(h, afterOpSelect(id));
    const a = first();
    await hold.reached;
    const b = second();
    await sleep(150);
    assert.equal(h.s.ops.has(id), false, 'the second request waits; nothing committed yet');
    hold.open();
    return [await a, await b];
  }
  {
    const h = await harness();
    const id = randomUUID();
    const [a, b] = await race(h, id, () => h.send(dicom({ study: ownStudy(h) }), { id }), () => h.send(dicom({ study: ownStudy(h) }), { id }));
    assert.deepEqual([a.status, b.status, b.body.code], [200, 409, 'OPERATION_CONTENT_CONFLICT'], JSON.stringify([a.body, b.body]));
    assert.deepEqual([h.s.op(id).results.length, h.s.file(id, 0).sha256], [1, a.body.sha256], 'the winner\'s entry stays');
  }
  {
    const h = await harness();
    const id = randomUUID();
    const [a, b] = await race(h, id, () => h.send(dicom({ study: ownStudy(h) }), { id, index: 0 }), () => h.send(dicom({ study: ownStudy(h) }), { id, index: 1 }));
    assert.deepEqual([a.status, b.status, h.s.op(id).results.map(e => e.outcome)], [200, 200, ['stored', 'stored']], 'no result lost');
  }
  {
    const h = await harness();
    const id = randomUUID();
    const [a, b] = await race(h, id, () => h.send(dicom({ study: ownStudy(h) }), { id }), () => h.send(dicom({ study: ownStudy(h) }), { id, as: TECH2 }));
    assert.deepEqual([a.status, b.status, b.body.code], [200, 409, 'OPERATION_CONFLICT']);
  }
  {
    const h = await harness();
    const id = randomUUID(), study = await downloadStudy(h, 1);
    const [a, b] = await race(h, id, () => h.send(dicom({ study: ownStudy(h) }), { id }), () => prepare(h, study, id, TECH));
    assert.deepEqual([a.status, b.status, b.body.code, h.s.op(id).kind], [200, 409, 'OPERATION_CONFLICT', 'import']);
  }
});

test('S9U4-B47 a database read or commit that fails before any intent is 503 IMPORT_STORAGE_UNAVAILABLE with nothing written (ASTRA-EXTRA-01) on import, preparation, status and archive; refusals and readiness keep their own answers; no database text leaves', async () => {
  const unavailable = () => { throw new Error('synthetic database read unavailable: relation "secret" password=x'); };
  const checks = [
    ['the institution list', h => { h.s.prisma.institution.findMany = unavailable; }],
    ['the StudyState read', h => { h.s.prisma.studyState.findUnique = unavailable; }],
    ['the StudyAccess policy read', h => { const q = h.s.prisma.$queryRaw; h.s.prisma.$queryRaw = (strings, ...values) => (strings.join('?').includes('StudyAccessPolicy') ? unavailable() : q(strings, ...values)); }],
    ['the operation lock', h => { h.s.onQuery = sql => { if (sql.includes('WHERE id = ?::uuid FOR UPDATE')) unavailable(); }; }],
  ];
  for (const [name, fail] of checks) {
    const h = await harness();
    const study = uid(); own(h.s, study);
    h.orthanc.store(dicom({ study }));
    fail(h);
    const r = await h.send(dicom({ study, series: study + '.9' }));
    assert.deepEqual([r.status, r.body.code], [503, 'IMPORT_STORAGE_UNAVAILABLE'], name);
    assert.ok(!JSON.stringify(r.body).includes('secret'), name + ': no database text');
    assert.deepEqual([posts(h.orthanc), [...h.s.ops.values()].filter(o => o.kind === 'import').length], [0, 0], name);
  }
  // Preparation, status and archive reads.
  {
    const h = await harness();
    const study = await downloadStudy(h, 1), id = randomUUID();
    assert.equal((await prepare(h, study, id)).status, 200);
    const read = h.s.prisma.studyState.findUnique;
    h.s.prisma.studyState.findUnique = unavailable;
    for (const [what, call] of [['prepare', () => prepare(h, study, randomUUID())], ['status', () => h.request('GET', `/api/studies/${study}/original-downloads/${id}`, { as: RAD })],
      ['archive', () => h.request('GET', archivePath(study, id), { as: RAD })]]) {
      const r = await call();
      assert.deepEqual([r.status, r.body?.code], [503, 'IMPORT_STORAGE_UNAVAILABLE'], what);
    }
    h.s.prisma.studyState.findUnique = read;
    const importOp = (await h.send(dicom({ study: uid() }))).id;
    h.s.prisma.importOperation.findUnique = unavailable;
    assert.deepEqual((await h.request('GET', '/api/dicom-import/' + importOp)).body.code, 'IMPORT_STORAGE_UNAVAILABLE', 'import status');
    assert.equal(h.s.op(id).download.attempts.length, 0, 'no attempt, no byte');
  }
  // Refusals keep their own answers under the same mapping.
  {
    const h = await harness();
    assert.equal((await h.send(dicom({ study: uid() }), { as: RAD })).status, 403);
    const existing = uid(); own(h.s, existing);
    h.s.policies.set(TECH.sub, deniedPolicy);
    assert.deepEqual([(await h.send(dicom({ study: existing }))).status], [404]);
    h.s.migration = false;
    assert.deepEqual((await h.send(dicom({ study: uid() }))).body.code, 'IMPORT_NOT_READY');
  }
});
// ── the migration's checks and the restore fixture's phases (U4BB-07, U4BB-13) ──

test('S9U4-B48 the store keeps the migration\'s checks with SQL NULL closed: each required column of each kind set NULL or malformed is a check violation; any number of member rows without a reservation key, one row per exact key', async () => {
  const h = await harness();
  const study = uid();
  const imported = await h.send(dicom({ study }));
  const dl = await downloadStudy(h, 1), downloadId = randomUUID();
  assert.equal((await prepare(h, dl, downloadId)).status, 200);
  const row = kind => [...h.s.ops.values()].find(r => r.kind === kind).id;
  const violations = [
    ['download manifestSha256 NULL', row('download') && downloadId, { manifestSha256: null }],
    ['download object NULL', downloadId, { download: null }],
    ['download manifestSha256 malformed', downloadId, { manifestSha256: 'not-a-sha256' }],
    ['download studyUid NULL', downloadId, { studyUid: null }],
    ['download status outside its states', downloadId, { status: 'reserved' }],
    ['study claim key NULL', row('study-claim'), { claimKey: null }],
    ['study claim NULL', row('study-claim'), { claim: null }],
    ['study claim key of another study', row('study-claim'), { claimKey: 'study:2.25.4242.8' }],
    ['SOP claim key NULL', row('sop-claim'), { claimKey: null }],
    ['SOP claim NULL', row('sop-claim'), { claim: null }],
    ['SOP claim key malformed', row('sop-claim'), { claimKey: 'sop:not-a-uid' }],
    ['member import with a reservation key', imported.id, { claimKey: 'sop:2.25.4242.7' }],
    ['member import results not an array', imported.id, { results: {} }],
    ['another kind', imported.id, { kind: 'gateway-import' }],
    ['the internal owner on a member row', downloadId, { ownerIssuer: 'kin-internal', ownerSubject: 'dicom-import-gate', actor: 'dicom-import-gate' }],
  ];
  for (const [name, id, data] of violations) {
    const before = h.s.op(id);
    await assert.rejects(h.s.prisma.$transaction(tx => tx.importOperation.update({ where: { id }, data }), { isolationLevel: 'ReadCommitted', maxWait: 4000, timeout: 8000 }),
      error => error.meta?.code === '23514', name);
    assert.deepEqual(h.s.op(id), before, name + ': rolled back');
  }
  // Any number of member rows without a key; a second row with an existing reservation key is a unique violation.
  const copyOf = (id, extra) => ({ ...h.s.op(id), id: randomUUID(), createdAt: new Date(T0), updatedAt: new Date(T0), ...extra });
  await h.s.prisma.importOperation.create({ data: copyOf(imported.id) });
  await h.s.prisma.importOperation.create({ data: copyOf(imported.id) });
  await assert.rejects(h.s.prisma.importOperation.create({ data: copyOf(row('sop-claim')) }), error => error.code === 'P2002');
});

test('S9U4-B49 a restart over the restore fixture\'s phases: the expired prepared attempt is fenced and its initializing claim removed (the next import initialises again), expired dispatching/unknown attempts are reconciled read-only with their holders kept, another instance\'s live attempt and every bound claim stay as they were, the expired sending download closes Unconfirmed with its row, Sent and prepared rows are untouched', async () => {
  const h = await harness();
  // The twelve rows of tests/ops_product_transfer_fixture.py import_operation_rows (REQ-S9-U4-13), with times relative to
  // the store's clock (leases expired a minute ago; the other instance's lease far ahead).
  const A = uid(), B = uid(), C = uid(), D = uid();
  for (const study of [A, B, C, D]) own(h.s, study, 'inst-a', 'local-import');
  const stamp = new Date(T0 - 120000).toISOString(), expired = new Date(T0 - 60000).toISOString(), live = '2099-01-01T00:00:00.000Z';
  const boot = randomUUID(), otherBoot = randomUUID();
  const ids = Object.fromEntries(['stored', 'first', 'unknown', 'dispatching', 'prepared', 'live'].map(n => [n, randomUUID()]));
  const attempt = (name, generation, phase, outcome, code, transport, extra = {}) => ({ attemptId: ids[name], actor: TECH.actor, generation,
    ownerInstance: boot, phase, leaseUntil: expired, startedAt: stamp, finishedAt: ['prepared', 'dispatching'].includes(phase) ? null : stamp,
    outcome, code, transport, autoRecheckedAt: null, recovery: null, ...extra });
  const entry = (index, study, outcome, code, attempts, identity = 'matched') => ({ index, sha256: (index + 1).toString(16).repeat(64),
    bytes: 1000 + index, studyUid: study, seriesUid: study + '.1', sopUid: study + '.1.' + (index + 1), expectedStudyUid: null, outcome, code,
    identity, writeDisposition: null, at: stamp, attempts });
  const U = ['unconfirmed', 'IMPORT_UNCONFIRMED'];
  const results = [
    entry(0, A, 'stored', null, [attempt('stored', 1, 'finished', 'stored', null, null)], 'new-study'),
    entry(1, A, ...U, [attempt('first', 1, 'finished', 'retryable', 'ORTHANC_UNAVAILABLE', 'certain-no-write'),
      attempt('unknown', 2, 'unknown', ...U, 'unknown', { autoRecheckedAt: stamp })]),
    entry(2, B, ...U, [attempt('dispatching', 1, 'dispatching', ...U, null)], 'not_comparable'),
    entry(3, C, ...U, [attempt('prepared', 1, 'prepared', ...U, null)], null),
    entry(4, D, ...U, [attempt('live', 1, 'dispatching', ...U, null, { ownerInstance: otherBoot, leaseUntil: live })]),
    { ...entry(5, A, 'rejected', 'MODALITY_NOT_IMPORTABLE', []), identity: null }];
  const member = { institutionId: 'inst-a', ownerIssuer: ISSUER, ownerSubject: TECH.sub, actor: TECH.actor };
  const gate = { institutionId: 'inst-a', ownerIssuer: 'kin-internal', ownerSubject: 'dicom-import-gate', actor: 'dicom-import-gate', status: 'reserved', results: [] };
  const create = data => h.s.prisma.importOperation.create({ data: { createdAt: new Date(stamp), updatedAt: new Date(stamp), ...data } });
  const opId = randomUUID();
  await create({ id: opId, ...member, kind: 'import', studyUid: null, status: 'open', results });
  const identity = { patientId: 'SYN-R', issuerInstitutionId: 'inst-a', nameKey: null, birthKey: null, sexKey: null };
  const blank = { patientId: null, issuerInstitutionId: null, nameKey: null, birthKey: null, sexKey: null };
  const studyClaim = (study, phase, holder) => create({ id: randomUUID(), ...gate, kind: 'study-claim', studyUid: study, claimKey: 'study:' + study,
    claim: { schemaVersion: 1, phase, institutionId: 'inst-a', studyUid: study, ...(phase === 'bound' ? identity : blank), heldByAttemptId: holder, createdAt: stamp } });
  const sopClaim = (index, holder) => { const e = results[index]; return create({ id: randomUUID(), ...gate, kind: 'sop-claim', studyUid: e.studyUid,
    claimKey: 'sop:' + e.sopUid, claim: { schemaVersion: 1, institutionId: 'inst-a', studyUid: e.studyUid, seriesUid: e.seriesUid, sopUid: e.sopUid,
      patientId: 'SYN-R', issuerInstitutionId: 'inst-a', sha256: e.sha256, bytes: e.bytes, heldByAttemptId: holder, createdAt: stamp } }); };
  await studyClaim(A, 'bound', ids.unknown); await studyClaim(B, 'bound', ids.dispatching); await studyClaim(C, 'initializing', ids.prepared);
  await studyClaim(D, 'bound', ids.live);
  await sopClaim(0, null); await sopClaim(1, ids.unknown); await sopClaim(2, ids.dispatching); await sopClaim(4, ids.live);
  // The downloads: prepared; Sent after an incomplete attempt; an expired sending attempt after an unconfirmed one.
  const dl = await downloadStudy(h, 2);
  const [prepared, sent, sending] = [randomUUID(), randomUUID(), randomUUID()];
  for (const id of [prepared, sent, sending]) assert.equal((await prepare(h, dl, id)).status, 200);
  assert.equal((await h.request('GET', archivePath(dl, sent), { as: RAD })).status, 200);
  await sleep(50);
  const sentAttempt = h.s.op(sent).download.attempts[0];
  const row = h.s.ops.get(sending);
  row.download.attempts.push({ ...sentAttempt, attemptId: randomUUID(), state: 'unconfirmed', archiveSha256: null, responseFinished: false, objects: sentAttempt.objects.slice(0, 1) },
    { ...sentAttempt, attemptId: randomUUID(), number: 2, state: 'sending', endedAt: null, leaseUntil: expired, archiveSha256: null, responseFinished: false, objects: sentAttempt.objects.slice(0, 1) });
  row.status = 'sending';
  const claimsBefore = Object.fromEntries([A, B, D].map(s => ['study:' + s, h.s.claim('study:' + s)]));
  const untouched = [h.s.op(prepared), h.s.op(sent)];
  const postsBefore = posts(h.orthanc);
  const counts = await h.gate.reconcileOnStart();
  const downloads = await h.transfer.expireDownloads();
  const files = h.s.op(opId).results;
  assert.deepEqual([files[3].outcome, files[3].code, files[3].attempts[0].transport], ['retryable', 'IMPORT_ATTEMPT_EXPIRED', 'certain-no-write'], 'prepared fenced');
  assert.equal(h.s.claim('study:' + C), null, 'its initializing claim removed');
  assert.deepEqual([files[2].outcome, files[2].attempts[0].phase, files[2].attempts[0].transport], ['unconfirmed', 'unknown', 'unknown'], 'dispatching -> unknown, read-only');
  assert.deepEqual([files[1].outcome, files[1].attempts[1].phase], ['unconfirmed', 'unknown'], 'unknown, nothing found: stays');
  assert.deepEqual(files[4], results[4], 'another instance\'s live attempt untouched');
  assert.deepEqual([files[0], files[5]], [results[0], results[5]]);
  for (const [key, before] of Object.entries(claimsBefore)) assert.deepEqual(h.s.claim(key), before, key + ': bound claims and their holders stay');
  assert.deepEqual([counts.fenced, counts.claimsRemoved, posts(h.orthanc)], [1, 0, postsBefore], 'no Orthanc write; the claim went with its fence');
  assert.equal(downloads, 1);
  assert.deepEqual(h.s.op(sending).download.attempts.map(a => a.state), ['unconfirmed', 'unconfirmed']);
  assert.equal(resultRows(h, row.download.attempts[1].attemptId).length, 1);
  assert.deepEqual([h.s.op(prepared), h.s.op(sent)], untouched);
  // The next import of Study C initialises it again from Orthanc (the removed claim left no baseline behind).
  h.orthanc.calls.length = 0;
  const again = await h.send(dicom({ study: C, series: C + '.1', id: 'SYN-R' }));
  assert.deepEqual([again.status, again.body.outcome, h.orthanc.calls.filter(c => c.path === '/tools/find').length], [200, 'stored', 1]);
});

test('S9U4-B50 the startup passes run by themselves when a server starts (no direct call): over a database holding an expired prepared import attempt and an expired sending download, the new server fences the attempt (its initializing claim removed, one result row, no Orthanc write) and closes the download Unconfirmed with one result row', async () => {
  const h = await harness();
  const study = uid();
  own(h.s, study, 'inst-a', 'local-import');
  const stamp = new Date(T0 - 120000).toISOString(), expired = new Date(T0 - 60000).toISOString();
  const attemptId = randomUUID(), opId = randomUUID();
  const attempt = { attemptId, actor: TECH.actor, generation: 1, ownerInstance: randomUUID(), phase: 'prepared', leaseUntil: expired, startedAt: stamp,
    finishedAt: null, outcome: 'unconfirmed', code: 'IMPORT_UNCONFIRMED', transport: null, autoRecheckedAt: null, recovery: null };
  const entry = { index: 0, sha256: 'a'.repeat(64), bytes: 1000, studyUid: study, seriesUid: study + '.1', sopUid: study + '.1.1', expectedStudyUid: null,
    outcome: 'unconfirmed', code: 'IMPORT_UNCONFIRMED', identity: null, writeDisposition: null, at: stamp, attempts: [attempt] };
  const create = data => h.s.prisma.importOperation.create({ data: { createdAt: new Date(stamp), updatedAt: new Date(stamp), ...data } });
  await create({ id: opId, institutionId: 'inst-a', ownerIssuer: ISSUER, ownerSubject: TECH.sub, actor: TECH.actor, kind: 'import', studyUid: null,
    status: 'open', results: [entry] });
  await create({ id: randomUUID(), institutionId: 'inst-a', ownerIssuer: 'kin-internal', ownerSubject: 'dicom-import-gate', actor: 'dicom-import-gate',
    status: 'reserved', results: [], kind: 'study-claim', studyUid: study, claimKey: 'study:' + study,
    claim: { schemaVersion: 1, phase: 'initializing', institutionId: 'inst-a', studyUid: study, patientId: null, issuerInstitutionId: null, nameKey: null,
      birthKey: null, sexKey: null, heldByAttemptId: attemptId, createdAt: stamp } });
  const dl = await downloadStudy(h, 1), sending = randomUUID();
  assert.equal((await prepare(h, dl, sending)).status, 200);
  const row = h.s.ops.get(sending), supply = randomUUID();
  row.download.attempts.push({ attemptId: supply, number: 1, ownerSubject: row.ownerSubject, actor: row.actor, manifestSha256: row.manifestSha256,
    destination: 'browser-download', state: 'sending', startedAt: stamp, endedAt: null, ownerInstance: randomUUID(), leaseUntil: expired, objects: [],
    archiveSha256: null, responseFinished: false });
  row.status = 'sending';
  const before = posts(h.orthanc);
  // A second server over the same database: its own onModuleInit passes find both rows; nothing here calls them.
  const h2 = await harness({ store: h.s });
  for (let i = 0; i < 100 && !(h.s.file(opId, 0).outcome === 'retryable' && h.s.op(sending).status === 'unconfirmed'); i++) await sleep(20);
  const file = h.s.file(opId, 0);
  assert.deepEqual([file.outcome, file.code, file.attempts[0].transport], ['retryable', 'IMPORT_ATTEMPT_EXPIRED', 'certain-no-write'], 'the import startup pass fenced it');
  assert.equal(h.s.claim('study:' + study), null, 'its initializing claim removed');
  assert.equal(audits(h.s, 'dicom.import.result').filter(a => a.detail.attemptId === attemptId).length, 1);
  assert.deepEqual([h.s.op(sending).status, h.s.op(sending).download.attempts.map(a => a.state)], ['unconfirmed', ['unconfirmed']], 'the download startup pass closed it');
  assert.equal(resultRows(h, supply).length, 1);
  assert.deepEqual([posts(h.orthanc), posts(h2.orthanc)], [before, 0], 'no Orthanc write');
});

test('S9U4-B51 the owner resends while its own prepared attempt (holding bound Study and SOP claims) has expired, with no GET before: the same intake transaction fences it with exactly one result row, the holders it released are taken by generation 2 there and then, and the file is stored once', async () => {
  const h = await harness();
  const study = uid(), bytes = dicom({ study });
  // The first request reserves both claims and then stalls at the pre-write lookup (its process "ends" there).
  h.orthanc.fault = call => (call.path === '/tools/lookup' ? { hang: true } : null);
  const pending = h.send(bytes);
  await new Promise(resolve => setTimeout(resolve, 150));
  const id = [...h.s.ops.values()].find(o => o.kind === 'import').id;
  h.orthanc.fault = null;
  const [held] = h.s.file(id, 0).attempts;
  const sopUid = h.s.file(id, 0).sopUid;
  assert.deepEqual([held.phase, h.s.claim('study:' + study).claim.phase, h.s.claim('study:' + study).claim.heldByAttemptId,
    h.s.claim('sop:' + sopUid).claim.heldByAttemptId], ['prepared', 'bound', held.attemptId, held.attemptId]);
  h.s.advance(Date.parse(held.leaseUntil) - h.s.clock);
  const again = await h.send(bytes, { id });
  assert.deepEqual([again.status, again.body.outcome, again.body.generation], [200, 'stored', 2]);
  assert.deepEqual(audits(h.s, 'dicom.import.result').filter(a => a.detail.attemptId === held.attemptId).map(a => a.detail.code), ['IMPORT_ATTEMPT_EXPIRED'],
    'the fenced attempt has exactly one result row');
  const [old, next] = h.s.file(id, 0).attempts;
  assert.deepEqual([old.outcome, old.code, old.transport, next.generation, next.outcome], ['retryable', 'IMPORT_ATTEMPT_EXPIRED', 'certain-no-write', 2, 'stored']);
  await pending;   // the stalled first request fails its own CAS later and writes nothing
  assert.deepEqual([h.s.file(id, 0).attempts.map(a => a.outcome), posts(h.orthanc)], [['retryable', 'stored'], 1], 'stored once; the late worker changed nothing');
});
