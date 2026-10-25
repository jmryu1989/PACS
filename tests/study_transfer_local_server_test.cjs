'use strict';
/* TEST-S9-U4 server half (S9-U4b part (b)): the compiled member import gate, feature controller/service and raw parser in a
 * real Nest HTTP application (the product's controller, services, parser and DI; a test guard stands in for Keycloak), over
 * a recording store that keeps ImportOperation's CHECK shapes, its UNIQUE keys, advisory and row locks and rolls a failed
 * transaction back, and a fake Orthanc HTTP server whose stored "files" answer /tags from their own bytes. The store keeps
 * the two PostgreSQL meanings a JSON copy loses (round 6, U4BL-01/02): SQL NULL and JSON null stay distinct in a JSONB
 * column as Prisma 5.22 writes them, and a JSONB value reads back with its object keys in jsonb's own order.
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
const { Prisma } = require('/app/node_modules/@prisma/client');
const { PrismaService } = require('/app/dist/prisma.service');
const { StudyAccessService } = require('/app/dist/study-access.service');
const { AuthService } = require('/app/dist/auth.service');
const { AuthGuard } = require('/app/dist/auth.guard');
const { createRequestContext, REQUEST_CONTEXT_CAPTURE, REQUEST_CONTEXT_SOURCE } = require('/app/dist/emr-runtime/request-context');
const { createRequestIngress } = require('/app/dist/emr-runtime/request-ingress');
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
// A stored JSONB column holds SQL NULL as JS null and a JSON null as JSON_NULL: it IS NOT NULL and is neither an object
// nor an array, so a required-NULL column holding it and a required object that is it both fail their branch, as on
// PostgreSQL. (The model is no substitute for the PostgreSQL CHECK/null/restore runs; it keeps what this file relies on.)
const JSON_NULL = Symbol('jsonb null');
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

// ── the ImportOperation columns as Prisma 5.22 writes them to PostgreSQL and reads them back ──
const OP_COLUMNS = ['id', 'institutionId', 'ownerIssuer', 'ownerSubject', 'actor', 'kind', 'studyUid', 'status', 'results', 'manifestSha256',
  'download', 'claimKey', 'claim', 'createdAt', 'updatedAt'];
const OP_REQUIRED = new Set(['id', 'institutionId', 'ownerIssuer', 'ownerSubject', 'actor', 'kind', 'status']);   // NOT NULL, no default
const OP_STAMPS = new Set(['createdAt', 'updatedAt']);   // NOT NULL DEFAULT now(): an explicit null is a not-null violation
const JSON_COLUMNS = new Set(['results', 'download', 'claim']);   // JSONB; results NOT NULL DEFAULT '[]', download/claim nullable
/**
 * What this store models of the ImportOperation table and what it does not (U4BL6-01): the migration's CHECKs (checkShape)
 * on every create and update; NOT NULL of the required columns and of the two time stamps (an explicit null refused, on
 * create and on update); the primary key on create and the claimKey UNIQUE on create and on update; JSONB's two nulls and
 * its key order. It does not model an update of the primary key and refuses one outright (a product update never sets it;
 * a store that let it through would answer for a database it is not), nor column types and lengths (uuid, varchar), nor
 * isolation beyond the row visibility and lock waits below. It is no proof of every NOT NULL or UNIQUE rule.
 */
const nullType = (value, name) => value instanceof Prisma.NullTypes[name];
const prismaError = (message, extra) => Object.assign(new Error(message), extra);
/**
 * One written column value as it lands in the row, decided before any copy (a JSON copy would turn a null sentinel into
 * {}). undefined is an omitted field (create: the column default; update: unchanged). On a JSONB column Prisma.DbNull is
 * SQL NULL, Prisma.JsonNull and a literal null (accepted by Prisma 5.22 through an any-typed value) are the JSON null
 * value; nested nulls are JSON values and stay. On other columns a literal null is SQL NULL and a null sentinel is refused.
 */
function opInput(column, value) {
  if (value === undefined) return undefined;
  if (!OP_COLUMNS.includes(column)) throw prismaError(`Unknown argument \`${column}\``, { name: 'PrismaClientValidationError' });
  const sentinel = ['DbNull', 'JsonNull', 'AnyNull'].find(name => nullType(value, name));
  if (!JSON_COLUMNS.has(column)) {
    if (sentinel) throw prismaError(`Invalid value for argument \`${column}\``, { name: 'PrismaClientValidationError' });
    if (value === null && OP_REQUIRED.has(column)) throw prismaError(`Argument \`${column}\` must not be null`, { name: 'PrismaClientValidationError' });
    if (value === null && OP_STAMPS.has(column)) throw prismaError(`null value in column "${column}" violates not-null constraint`, { code: 'P2011', meta: { code: '23502' } });
    return value instanceof Date ? value.toISOString() : value;
  }
  if (sentinel === 'AnyNull') throw prismaError(`Invalid value for argument \`${column}\``, { name: 'PrismaClientValidationError' });
  if (sentinel === 'DbNull') {
    if (column === 'results') throw prismaError('null value in column "results" violates not-null constraint', { code: 'P2011', meta: { code: '23502' } });
    return null;
  }
  if (sentinel === 'JsonNull' || value === null) return JSON_NULL;
  return JSON.parse(JSON.stringify(value));
}
/**
 * A JSONB value as PostgreSQL 16 gives it back: every object's keys in jsonb's storage order - shorter UTF-8 byte length
 * first, then bytewise - and a new value, never the written one. Array order, strings and numbers stay as they are (JS's
 * own enumeration of integer-like keys then applies exactly as after JSON.parse of the database's text).
 */
const jsonbKeyOrder = (a, b) => { const x = Buffer.from(a, 'utf8'), y = Buffer.from(b, 'utf8'); return x.length - y.length || Buffer.compare(x, y); };
const jsonbValue = v => (Array.isArray(v) ? v.map(jsonbValue)
  : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort(jsonbKeyOrder).map(k => [k, jsonbValue(v[k])])) : v);
/** A stored ImportOperation row as Prisma reads it: both nulls of a JSONB column are JS null; JSONB values in jsonb order. */
function opRead(row) {
  if (!row) return null;
  const read = {};
  for (const column of OP_COLUMNS) {
    const v = row[column];
    read[column] = column === 'createdAt' || column === 'updatedAt' ? new Date(v)
      : JSON_COLUMNS.has(column) ? (v === null || v === JSON_NULL ? null : jsonbValue(v)) : v;
  }
  return read;
}

function store({ institutions } = {}) {
  const s = { ops: new Map(), states: new Map(), audits: [], clock: T0, migration: true, policies: new Map(), sessions: new Set(),
    rights: new Map(), auditFailure: null, failNextWrite: null, writes: 0, onQuery: null, onAuth: null, expiredTokens: new Set(), idpEnded: new Set(), reads: [],
    sessionSubs: new Map(), guardCalls: [],
    institutions: institutions ?? [{ id: 'inst-a', name: 'Synthetic A', dicomNames: 'SYN A,SYNTHETIC-A' }, { id: 'inst-b', name: 'Synthetic B', dicomNames: 'SYN B' }] };
  for (const c of [TECH, TECH2, RAD, ADMIN, ADMIN2, TECH_B, ADMIN_B]) s.rights.set(c.sub, { sub: c.sub, approved: true, suspended: false, institution: c.institution, roles: c.roles });
  const advisory = new Map(), rows = new Map();
  const lock = async (map, key, held) => {
    if (held.keys.has(map === advisory ? 'a:' + key : 'r:' + key)) return;
    const prev = map.get(key) || Promise.resolve(); let release; const mine = new Promise(r => { release = r; });
    map.set(key, prev.then(() => mine)); await prev; held.list.push(release); held.keys.add(map === advisory ? 'a:' + key : 'r:' + key);
  };
  const copy = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const out = opRead;
  /** The written fields of one create/update, column by column (opInput), omitted ones left out. */
  const written = data => {
    const fields = {};
    for (const [column, value] of Object.entries(data)) {
      const stored = opInput(column, value);
      if (stored !== undefined) fields[column] = stored;
    }
    return fields;
  };
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
        // The column defaults: SQL NULL for the nullable columns, '[]' for results, the database time for the two stamps.
        const row = { studyUid: null, results: [], manifestSha256: null, download: null, claimKey: null, claim: null,
          createdAt: new Date(s.clock).toISOString(), updatedAt: new Date(s.clock).toISOString(), ...written(data) };
        const missing = [...OP_REQUIRED].find(column => row[column] === undefined);
        if (missing) throw prismaError(`Argument \`${missing}\` is missing`, { name: 'PrismaClientValidationError' });
        await settle(() => s.ops.get(row.id));
        if (row.claimKey !== null) await settle(() => [...s.ops.values()].find(r => r.claimKey === row.claimKey));
        if (s.ops.has(row.id)) throw Object.assign(new Error('Unique constraint failed (id)'), { code: 'P2002' });
        if (row.claimKey !== null && [...s.ops.values()].some(r => r.claimKey === row.claimKey)) throw Object.assign(new Error('Unique constraint failed (claimKey)'), { code: 'P2002' });
        checkShape(row); if (tx) row._tx = tx.id; s.ops.set(row.id, row); created('op', row.id); s.writes++; undo(() => s.ops.delete(row.id)); return out(row);
      },
      update: async ({ where, data }) => {
        fail();
        const before = s.ops.get(where.id); if (!before) throw Object.assign(new Error('not found'), { code: 'P2025' });
        const changes = written(data);
        if ('id' in changes && changes.id !== before.id) throw prismaError('this test store does not model an update of the primary key `id`', { name: 'UnmodelledStoreUpdate' });
        const after = { ...before, updatedAt: new Date(s.clock).toISOString(), ...changes };
        checkShape(after);
        // The claimKey UNIQUE on update as on create (U4BL6-01): a key another row holds, committed or not, is refused.
        if (after.claimKey !== null && after.claimKey !== before.claimKey) {
          await settle(() => [...s.ops.values()].find(r => r !== before && r.claimKey === after.claimKey));
          if ([...s.ops.values()].some(r => r !== before && r.claimKey === after.claimKey)) throw Object.assign(new Error('Unique constraint failed (claimKey)'), { code: 'P2002' });
        }
        s.ops.set(where.id, after); s.writes++; undo(() => s.ops.set(where.id, before)); return out(after);
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
          // The attempt CAS of a download chunk: the row lock (if the row exists), then the last attempt's fields as
          // PostgreSQL's ->> gives them (text: the number too).
          if (!tx) throw new Error('row lock outside a transaction');
          tx.operationLocked = true;
          tx.casOperation = values[0];
          const row = s.ops.get(values[0]);
          if (!seen(row) || row.kind !== 'download') return [];
          await lock(rows, row.id, tx.held);
          const now = s.ops.get(row.id), last = now.download.attempts[now.download.attempts.length - 1];
          return [{ status: now.status, attemptId: last?.attemptId ?? null, number: last ? String(last.number) : null, state: last?.state ?? null,
            leaseUntil: last?.leaseUntil ?? null }];
        }
        if (sql.includes('FROM "StudyState" WHERE uid = ? FOR SHARE')) {
          // A shared row lock on the study (modelled as the row's lock: nothing in this file takes it exclusively).
          if (!tx) throw new Error('row lock outside a transaction');
          const row = s.states.get(values[0]);
          if (!seen(row)) return [];
          await lock(rows, 'state:' + values[0], tx.held);
          return s.states.has(values[0]) ? [{ institutionId: s.states.get(values[0]).institutionId }] : [];
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
    // it, so a row read after its lock is current) and a bounded wait and duration. B2's transactionWithRecords (the
    // download stages) leaves the level unset, which is PostgreSQL's default READ COMMITTED; no other level is accepted.
    assert.equal(options?.isolationLevel ?? 'ReadCommitted', 'ReadCommitted');
    assert.ok([options?.maxWait, options?.timeout].every(v => Number.isFinite(v) && v > 0), 'a bounded transaction');
    const tx = { id: ++transactionSeq, undo: [], created: [], held: { list: [], keys: new Set() }, operationLocked: false };
    s.openTransactions++;
    let ended;
    running.set(tx.id, new Promise(resolve => { ended = resolve; }));
    const db = api(tx);
    let value;
    try {
      value = await fn(db);
      // A test may fail the COMMIT itself (the work is rolled back; the caller sees an error).
      if (s.onCommit) await s.onCommit(tx);
      // Commit: what this transaction created becomes visible to every other one, then its locks go.
      for (const [kind, key] of tx.created) { const row = kind === 'op' ? s.ops.get(key) : s.states.get(key); if (row) delete row._tx; }
    }
    catch (error) { for (const fn of tx.undo.reverse()) fn(); throw error; }
    finally { tx.held.list.forEach(release => release()); running.delete(tx.id); ended(); s.openTransactions--; }
    // A test may delay the commit's answer to the caller after the commit and its lock release (a slow network back).
    if (s.onCommitted) await s.onCommitted(tx);
    return value;
  };
  // The test's own reads of a stored row (as psql's to_jsonb shows it: stamps as text, both JSONB nulls as null); which
  // null a JSONB column holds is s.nullKind's.
  const view = row => (row ? { ...opRead(row), createdAt: row.createdAt, updatedAt: row.updatedAt } : null);
  s.op = id => view(s.ops.get(id));
  s.claim = key => view([...s.ops.values()].find(r => r.claimKey === key));
  s.nullKind = (id, column) => { const v = s.ops.get(id)[column]; return v === null ? 'SQL NULL' : v === JSON_NULL ? 'JSON null' : typeof v; };
  s.file = (id, index) => s.op(id)?.results.find(e => e.index === index);
  s.actions = () => s.audits.map(a => a.action);
  s.advance = ms => { s.clock += ms; };
  return s;
}

// ── the Nest application: the product's controller, services and parser; a test guard stands in for the global AuthGuard ──
class TestGuard {
  constructor(capture) { this.capture = capture; }
  canActivate(ctx) {
    const req = ctx.switchToHttp().getRequest();
    const c = JSON.parse(req.headers['x-test-caller'] || 'null');
    if (!c) throw new common.UnauthorizedException();
    Object.assign(req, c, c.session ? { authMethod: 'session', sid: c.session } : { authMethod: 'bearer' });
    // The credential the real guard verified: a bearer caller carries its synthetic access token on the same request.
    if (!c.session) req.headers.authorization = 'Bearer ' + (c.token ?? 'tok:' + c.sub);
    this.capture.capture(req, ctx.switchToHttp().getResponse(), {
      issuer: process.env.KC_ISSUER || 'https://synthetic.test/fixture', subject: c.sub || 'fixture-missing-subject',
      roles: c.roles, institution: c.institution, rightsVersion: 1,
      binding: { method: 'bearer', sessionRef: null },
    }, { method: req.method, route: req.route.path.replace(/^\/api\//, ''), purpose: 'clinical' }, async () => {});
    return true;
  }
}
common.Injectable()(TestGuard);
common.Inject(REQUEST_CONTEXT_CAPTURE)(TestGuard, undefined, 0);

/**
 * AuthService's public checks over the store: a cookie session lives while its row does; a synthetic bearer token
 * 'tok:<sub>' verifies until it is marked expired, and its provider session 'idp:<sub>' until it is marked ended. The
 * real verification and marks are AuthService's own suites; this file asserts what the routes do with their answers.
 * A test may hold or slow a credential check before it answers (s.onAuth), as it may a statement (s.onQuery).
 */
function fakeAuth(s) {
  return {
    hasSession: async req => { if (s.onAuth) await s.onAuth(); if (s.authFailure) throw s.authFailure(); return s.sessions.has(req.sid); },
    verifyAccessToken: async raw => {
      if (s.onAuth) await s.onAuth();
      if (s.authFailure) throw s.authFailure();
      if (!raw.startsWith('tok:') || s.expiredTokens.has(raw)) throw new common.UnauthorizedException('토큰 검증 실패: synthetic');
      return { iss: process.env.KC_ISSUER, sub: raw.slice(4), sid: 'idp:' + raw.slice(4) };
    },
    bearerRights: async payload => {
      if (s.idpEnded.has(payload.sid)) throw new common.UnauthorizedException({ code: 'AUTH_SESSION_ENDED', message: '인증 세션이 없습니다' });
      return s.rights.get(payload.sub) ?? null;
    },
  };
}

/**
 * D1489 (archive grant): the product's AuthGuard itself in front of the routes, over AuthService's public checks as the
 * guard calls them - a kin_sid cookie names a session of s.sessionSubs; its binding header is 'ref:<sid>' (the guard's
 * sessionRef); a missing/other header is 428/409 with the product's codes; a session answers its stored token, whose
 * subject's durable rights are the store's; CSRF is X-KIN-CSRF: 1. Every call is counted in s.guardCalls, so a case can
 * show that a refusal came before authentication, refresh or the handler.
 */
function guardAuth(s) {
  const base = fakeAuth(s);
  const ref = sid => 'ref:' + sid;
  const refusal = (status, code, message) => new common.HttpException({ code, message }, status);
  const count = name => { s.guardCalls.push(name); };
  return { ...base,
    sessionId: req => /(?:^|;\s*)kin_sid=([^;]+)/.exec(String(req.headers.cookie ?? ''))?.[1] ?? null,
    sessionRef: sid => ref(sid),
    binding: (req, sid) => { const sent = req.headers['x-kin-session']; return sent === undefined ? 'missing' : sent === ref(sid) ? 'bound' : 'mismatch'; },
    requireBinding(req, sid) {
      const b = this.binding(req, sid);
      if (b === 'missing') throw refusal(428, 'AUTH_SESSION_REQUIRED', '요청에 로그인 세션 식별값(X-KIN-Session)이 없습니다');
      if (b === 'mismatch') throw refusal(409, 'AUTH_SESSION_MISMATCH', '이 요청을 시작한 로그인 세션이 지금 브라우저의 세션과 다릅니다');
    },
    authenticateSession: async sid => {
      count('authenticateSession');
      if (!s.sessions.has(sid)) throw refusal(401, 'AUTH_SESSION_ENDED', '인증 세션이 없습니다');
      return { sid, sub: s.sessionSubs.get(sid), accessToken: 'tok:' + s.sessionSubs.get(sid) };
    },
    verifyAccessToken: async raw => {
      count('verifyAccessToken');
      const payload = await base.verifyAccessToken(raw);
      // A Gateway client-credentials token as Keycloak issues it (azp gw-*, the gateway role, one group).
      if (payload.sub.startsWith('gw-')) return { ...payload, azp: 'gw-synthetic', realm_access: { roles: ['gateway'] }, groups: ['/inst-a'] };
      const r = s.rights.get(payload.sub);
      return { ...payload, email: payload.sub.replace(/-sub$/, '') + '@synthetic.test', realm_access: { roles: r?.roles ?? [] }, groups: r ? ['/' + r.institution] : [] };
    },
    sessionRights: async session => { count('sessionRights'); return s.rights.get(session.sub) ?? null; },
    bindCurrentAuthorization: payload => async () => {
      const row = s.rights.get(payload.sub);
      if (!row?.approved || row.suspended) throw new common.ForbiddenException();
    },
    credentialsMissing: () => refusal(401, 'AUTH_CREDENTIALS_MISSING', '인증 정보가 없습니다'),
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
  // WORKLIST-SPLIT-UID (main 848b7e5): StudyAccess reads one UID's original resources through studyIdentityResources -
  // its per-request source observation (prepareSourceIdentity) and a restricted policy's metadata (prepare). By default
  // the fake's own originals answer: one QIDO row per Orthanc Study resource of the UID (PatientID + StudyInstanceUID,
  // as the fake keys its instances). Each read is recorded with the transactions open at that moment;
  // orthanc.sourceFault makes it fail. options.accessOrthanc replaces it (a policy case's own source).
  orthanc.sourceReads = [];
  const studyIdentityResources = async studyUid => {
    orthanc.sourceReads.push({ studyUid, openTransactions: s.openTransactions ?? 0 });
    if (orthanc.sourceFault) throw new Error('synthetic source read failure');
    const patients = [...new Set([...orthanc.instances.values()].filter(i => i.h.studyInstanceUid === studyUid).map(i => i.h.patientId ?? ''))];
    return patients.map(patient => ({ '0020000D': { vr: 'UI', Value: [studyUid] }, '00100020': { vr: 'LO', Value: [patient] } }));
  };
  const access = new StudyAccessService(s.prisma, { studyIdentityResources, ...(options.accessOrthanc ?? {}) }, {});
  class TestModule {}
  const identities = new Map();
  const requests = createRequestContext(createRequestIngress({proxyPeers:[]}), {
    begin() {
      return {
        resolveRequestIdentity: async (issuer, subject) => {
          const key = JSON.stringify([issuer, subject]);
          if (!identities.has(key)) identities.set(key, randomUUID());
          return identities.get(key);
        },
        // This recording store models the port's transaction only. The live
        // HTTP/PG test exercises B2 admission, parsing and durable appends.
        transactionWithRecords: (task, bounds) => s.prisma.$transaction(tx => task(tx, (_event, effect) => effect()), bounds),
        end() {},
      };
    },
  });
  common.Module({ controllers: [StudyTransferLocalController], providers: [StudyTransferLocalService, Gate.DicomImportGateService,
    { provide: REQUEST_CONTEXT_CAPTURE, useValue: requests.capture },
    { provide: REQUEST_CONTEXT_SOURCE, useValue: requests.source },
    { provide: PrismaService, useValue: s.prisma }, { provide: StudyAccessService, useValue: access },
    { provide: AuthService, useValue: options.realGuard ? guardAuth(s) : fakeAuth(s) },
    { provide: APP_GUARD, useClass: options.realGuard ? AuthGuard : TestGuard }] })(TestModule);
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

async function unknownAttempt(h, { study = uid(), stored = false, as = TECH } = {}) {
  const bytes = dicom({ study });
  if (stored) h.orthanc.fault = call => (call.path === '/instances' ? { lose: true } : null);
  const restore = stored ? () => {} : failPost(fetchError('ECONNRESET'));
  let r;
  try { r = await h.send(bytes, { as }); } finally { restore(); h.orthanc.fault = null; }
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
  // Sent is final: a repeat supplies no bytes and records the refused start; a new id prepares again.
  const before = h.s.op(id), audited = h.s.audits.length;
  const again = await h.request('GET', `/api/studies/${study}/original-downloads/${id}/archive`, { as: RAD });
  assert.deepEqual([again.status, again.body.code, again.headers['content-type'].startsWith('application/json')], [409, 'DOWNLOAD_ALREADY_SENT', true]);
  assert.deepEqual(h.s.op(id), before, 'the operation and its Sent attempt are unchanged');
  assert.equal(h.s.audits.length, audited + 1);
  assert.deepEqual(audits(h.s, 'original.download.refused').map(a => a.detail.code), ['DOWNLOAD_ALREADY_SENT']);
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
  // U4BB5-01: the refusal by its behaviour - the status, the code read null-safe (a stream answer has no JSON body), the
  // attempt list and the state unchanged, no byte - so a missing refusal fails on these, never on a TypeError.
  const live = await h.request('GET', `/api/studies/${study2}/original-downloads/${id2}/archive`, { as: RAD });
  assert.deepEqual([live.status, live.body?.code ?? null], [409, 'DOWNLOAD_IN_PROGRESS'], 'a live sending lease refuses a second archive');
  assert.notEqual(live.headers['content-type'], 'application/zip', 'no archive starts');
  assert.deepEqual([h.s.op(id2).download.attempts.length, h.s.op(id2).status], [1, 'sending'], 'no new attempt, the state unchanged');
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
  let served = 0, release, ready;
  const held = new Promise(resolve => { release = resolve; });
  const checkpointed = new Promise(resolve => { ready = resolve; });
  h.orthanc.fault = async call => {
    if (call.path.endsWith('/file') && ++served === 2) { ready(); await held; }
    return null;
  };
  const archive = h.request('GET', archivePath(study, id), { as });
  // The writer checkpoints object 1 before requesting object 2; elapsed time cannot establish that boundary.
  try {
    await Promise.race([checkpointed, archive.then(() => { throw new Error('archive ended before its held source'); })]);
    assert.deepEqual(h.s.op(id).download.attempts[0].objects.map(o => o.complete), [true], 'object 1 checkpointed before returning the held archive');
  } catch (error) { release(); throw error; }
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
    let b = null;
    try {
      await hold.reached;
      b = second();
      await sleep(150);
      assert.equal(h.s.ops.has(id), false, 'the second request waits; nothing committed yet');
    } finally {
      // U4BB3-05: the held request is let go and both requests settle even when an assertion above failed, so a failure
      // ends this case as itself (never as the file's timeout with a request still held).
      hold.open();
      await Promise.allSettled([a, b].filter(Boolean));
    }
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
  // SQL NULL on a JSONB column is Prisma.DbNull (a literal null there is the JSON null value: S9U4-B69's vectors).
  const violations = [
    ['download manifestSha256 NULL', row('download') && downloadId, { manifestSha256: null }],
    ['download object NULL', downloadId, { download: Prisma.DbNull }],
    ['download manifestSha256 malformed', downloadId, { manifestSha256: 'not-a-sha256' }],
    ['download studyUid NULL', downloadId, { studyUid: null }],
    ['download status outside its states', downloadId, { status: 'reserved' }],
    ['study claim key NULL', row('study-claim'), { claimKey: null }],
    ['study claim NULL', row('study-claim'), { claim: Prisma.DbNull }],
    ['study claim key of another study', row('study-claim'), { claimKey: 'study:2.25.4242.8' }],
    ['SOP claim key NULL', row('sop-claim'), { claimKey: null }],
    ['SOP claim NULL', row('sop-claim'), { claim: Prisma.DbNull }],
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
  // Any number of member rows without a key; a second row with an existing reservation key is a unique violation. A copy
  // of a read row is written the way Prisma takes it: its JSONB columns that are SQL NULL by the kind's shape written as
  // Prisma.DbNull, never as the null they read back as (that literal null is the JSON null value and the check refuses it).
  const copyOf = (id, extra) => ({ ...h.s.op(id), id: randomUUID(), createdAt: new Date(T0), updatedAt: new Date(T0), ...extra });
  const sqlNull = { download: Prisma.DbNull, claim: Prisma.DbNull };
  await h.s.prisma.importOperation.create({ data: copyOf(imported.id, sqlNull) });
  await h.s.prisma.importOperation.create({ data: copyOf(imported.id, sqlNull) });
  await assert.rejects(h.s.prisma.importOperation.create({ data: copyOf(row('sop-claim'), { download: Prisma.DbNull }) }), error => error.code === 'P2002');
  const rows = h.s.ops.size;
  await assert.rejects(h.s.prisma.importOperation.create({ data: copyOf(imported.id) }), error => error.meta?.code === '23514', 'the read nulls copied as they are');
  assert.equal(h.s.ops.size, rows, 'nothing inserted');
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

// ════════════════════════════════ round 3: a chunk is supplied only under its approval (U4BB2-01) ════════════════════════════════

/**
 * What the server submits to each archive response as it submits it - every write (its bytes, what write returned) and
 * whether the response was ended - read off the http.ServerResponse itself, not from the client, whose receipt lags.
 * The oracles below count these submissions and their byte offsets; they never count the product's own checks.
 */
const submissions = [];
{
  const { write, end } = http.ServerResponse.prototype;
  const record = res => {
    if (!/\/original-downloads\/[^/]+\/archive$/.test(res.req?.url ?? '')) return null;
    let r = submissions.find(x => x.res === res);
    if (!r) { r = { res, url: res.req.url, calls: 0, bytes: 0, chunks: [], ended: false, lastReturn: true, onWrite: null }; submissions.push(r); }
    return r;
  };
  http.ServerResponse.prototype.write = function (chunk, ...rest) {
    const r = record(this);
    const answer = write.call(this, chunk, ...rest);
    if (r && chunk && chunk.length) {
      r.calls += 1; r.bytes += chunk.length; r.chunks.push(Buffer.from(chunk)); r.lastReturn = answer;
      if (r.onWrite) r.onWrite(r);
    }
    return answer;
  };
  http.ServerResponse.prototype.end = function (...args) {
    const r = record(this);
    if (r) r.ended = true;
    return end.apply(this, args);
  };
}
/** The first response the server opened for this archive path (the old worker's when a retry follows it). */
const submitted = (study, id) => submissions.find(r => r.url === archivePath(study, id));
/** Byte offsets of each object's entry, by the contract's formula (5.2: L_i = 30 + f_i + s_i + 16) over the stored manifest. */
function layout(h, id) {
  let at = 0;
  return JSON.parse(h.s.op(id).download.manifestCanonical).objects.map(o => {
    const payload = at + 30 + Buffer.byteLength(o.path, 'utf8');
    const entry = { header: at, payload, descriptor: payload + o.bytes, end: payload + o.bytes + 16 };
    at = entry.end;
    return entry;
  });
}
const CENTRAL_SIG = Buffer.from([0x50, 0x4b, 0x01, 0x02]), END_SIG = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const statusPath = (study, id) => `/api/studies/${study}/original-downloads/${id}`;
const policyRead = sql => sql.includes('"StudyAccessPolicy"');
/** A barrier released in finally: hold() parks a statement until open(); held resolves when one is parked. */
function barrier() {
  let open, parked;
  const gate = new Promise(resolve => { open = resolve; });
  const held = new Promise(resolve => { parked = resolve; });
  return { gate, held, open: () => open(), park: async () => { parked(); await gate; } };
}
const within = (promise, ms) => Promise.race([promise.then(() => true), sleep(ms).then(() => false)]);

/** The old worker after its fence: no submission since W0/B0, no finish, its checkpoint as it was, Unconfirmed, one result row. */
async function assertNothingAfterFence(h, held, sub, mark, checkpoint, at, payloadStart) {
  const answer = await held.archive;
  await sleep(80);
  assert.deepEqual([sub.calls - mark.W0, sub.bytes - mark.B0], [0, 0], 'no sink write call and no byte after the fence committed');
  const bytes = Buffer.concat(sub.chunks);
  assert.equal(bytes.length, sub.bytes);
  if (payloadStart !== undefined) assert.equal(Math.max(0, sub.bytes - payloadStart), 0, 'not one payload byte of object 2');
  assert.ok(!bytes.subarray(at[0].end).includes(Buffer.from([0x50, 0x4b, 0x07, 0x08])), 'no descriptor of object 2');
  assert.ok(!bytes.includes(CENTRAL_SIG) && !bytes.includes(END_SIG), 'no manifest entry, central directory or end record');
  assert.deepEqual([sub.ended, answer.complete], [false, false], 'no finish of the old response');
  const [a] = h.s.op(held.id).download.attempts;
  assert.deepEqual(a.objects, checkpoint, 'the checkpoint committed before the fence is unchanged');
  assert.deepEqual([a.state, a.archiveSha256, a.responseFinished], ['unconfirmed', null, false]);
  assert.equal(resultRows(h, a.attemptId).length, 1, 'exactly one result row for the old attempt');
  return a;
}

test('S9U4-B52 a chunk is supplied only under its approval (U4BB2-01): the rights read of object 2\'s first payload held while the DB clock passes the lease and a GET commits the old attempt\'s Unconfirmed, then released as valid - no further write or byte; a read held inside the approval\'s lock - the fence waits, the lease check refuses after the release, then the fence commits; the commit answer delayed after the lock release - nothing after the fence; a retry sends the whole archive', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });   // only the approvals before each chunk act, never the 10 s timer
  // (a) The read before the lock: a fence can commit while it waits. Its answer (valid rights) supplies nothing after it.
  {
    const h = await harness();
    const held = await heldArchive(h);
    const at = layout(h, held.id), sub = submitted(held.study, held.id);
    assert.ok(sub && sub.bytes === at[0].end, 'object 1 complete and checkpointed; object 2 held at its source');
    const checkpoint = h.s.op(held.id).download.attempts[0].objects;
    const b = barrier();
    let armed = false;
    sub.onWrite = r => { if (r.bytes === at[1].payload) armed = true; };
    h.s.onQuery = async (sql, _values, tx) => { if (armed && !tx && policyRead(sql)) { armed = false; await b.park(); } };
    const mark = {};
    try {
      held.release();
      assert.ok(await within(b.held, 3000), 'the rights read of object 2\'s first payload is held');
      assert.equal(sub.bytes, at[1].payload, 'object 2\'s local header supplied, not one payload byte');
      h.s.advance(31000);
      const fence = await h.request('GET', statusPath(held.study, held.id), { as: RAD });
      assert.deepEqual([fence.status, fence.body.attempts[0].state], [200, 'unconfirmed'], 'the normal expiry path committed the fence');
      Object.assign(mark, { W0: sub.calls, B0: sub.bytes });
    } finally { b.open(); h.s.onQuery = null; }
    await assertNothingAfterFence(h, held, sub, mark, checkpoint, at, at[1].payload);
    // A new attempt after the fence: the whole archive, Sent.
    const retry = await h.request('GET', archivePath(held.study, held.id), { as: RAD });
    assert.equal(retry.bytes.length, Number(retry.headers['content-length']));
    await sleep(50);
    assert.deepEqual(h.s.op(held.id).download.attempts.map(a => a.state), ['unconfirmed', 'sent']);
  }
  // (b) The rights read that follows the approval's own read of the attempt (the lease read): held. It is inside the
  // approval's lock, so the fence waits for that lock. DB clock +31 s -> read released -> the approval's lease check
  // refuses (nothing written) -> its lock goes -> the fence commits. The read is released whatever the fence does.
  {
    const h = await harness();
    const held = await heldArchive(h);
    const at = layout(h, held.id), sub = submitted(held.study, held.id);
    const checkpoint = h.s.op(held.id).download.attempts[0].objects;
    const b = barrier();
    let armed = false, leaseRead = false;
    sub.onWrite = r => { if (r.bytes === at[1].payload) armed = true; };
    h.s.onQuery = async (sql, _values, tx) => {
      if (armed && casSql(sql)) leaseRead = true;
      else if (armed && leaseRead && policyRead(sql)) { armed = false; await b.park(); }
    };
    const order = [], mark = {};
    let fence;
    try {
      held.release();
      assert.ok(await within(b.held, 3000), 'the rights read after the lease read is held');
      Object.assign(mark, { W0: sub.calls, B0: sub.bytes });
      h.s.advance(31000);
      order.push('db-time+31s');
      fence = h.request('GET', statusPath(held.study, held.id), { as: RAD }).then(r => { order.push('fence-committed'); return r; });
      await sleep(150);
      assert.deepEqual([order.includes('fence-committed'), h.s.op(held.id).download.attempts[0].state], [false, 'sending'], 'the fence waits for the approval\'s row lock');
    } finally { order.push('read-released'); b.open(); h.s.onQuery = null; }
    const answer = await fence;
    assert.deepEqual([answer.status, answer.body.attempts[0].state], [200, 'unconfirmed']);
    assert.deepEqual(order, ['db-time+31s', 'read-released', 'fence-committed']);
    await assertNothingAfterFence(h, held, sub, mark, checkpoint, at, at[1].payload);
  }
  // (c) Regression control: the approval's commit answer delayed after its lock was released, and a fence committed in
  // that gap. The chunk it approved was supplied before the commit (under the lock); nothing is supplied after the fence.
  {
    const h = await harness();
    const held = await heldArchive(h);
    const at = layout(h, held.id), sub = submitted(held.study, held.id);
    const checkpoint = h.s.op(held.id).download.attempts[0].objects;
    let armed = true, delayed = false;
    const mark = {};
    // Nothing is in flight now (object 2 waits at its source): the next approval to start is object 2's local header.
    h.s.onQuery = async (sql, _values, tx) => { if (armed && tx && casSql(sql)) { armed = false; tx.watched = true; } };
    h.s.onCommitted = async tx => {
      if (!tx.watched || delayed) return;
      delayed = true;
      h.s.advance(31000);
      const fence = await h.request('GET', statusPath(held.study, held.id), { as: RAD });
      assert.equal(fence.body.attempts[0].state, 'unconfirmed');
      Object.assign(mark, { W0: sub.calls, B0: sub.bytes });
    };
    try {
      held.release();
      for (let i = 0; i < 100 && !mark.W0; i++) await sleep(20);
    } finally { h.s.onQuery = null; }
    h.s.onCommitted = null;
    await assertNothingAfterFence(h, held, sub, mark, checkpoint, at, at[1].payload);
    assert.equal(mark.B0, at[1].payload, 'the approved local header was handed to the response before its transaction committed');
  }
});

test('S9U4-B53 the same gate for every write (U4BB2-01): a fence before object 2\'s local header, before its descriptor or while the writer waits for a blocked receiver\'s drain leaves no further write; a commit answer lost after a supply stops the archive Unconfirmed without supplying that chunk again; an approval that ran past its bound while the event loop was stalled supplies nothing', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  // Before the local header: the fence commits while object 2 is still held at its source.
  {
    const h = await harness();
    const held = await heldArchive(h);
    const at = layout(h, held.id), sub = submitted(held.study, held.id);
    const checkpoint = h.s.op(held.id).download.attempts[0].objects;
    h.s.advance(31000);
    assert.equal((await h.request('GET', statusPath(held.study, held.id), { as: RAD })).body.attempts[0].state, 'unconfirmed');
    const mark = { W0: sub.calls, B0: sub.bytes };
    held.release();
    await assertNothingAfterFence(h, held, sub, mark, checkpoint, at, at[1].header);
    assert.equal(sub.bytes, at[0].end, 'no local header of object 2');
  }
  // Before the descriptor: the rights read of object 2's descriptor is held after its last payload byte.
  {
    const h = await harness();
    const held = await heldArchive(h);
    const at = layout(h, held.id), sub = submitted(held.study, held.id);
    const checkpoint = h.s.op(held.id).download.attempts[0].objects;
    const b = barrier();
    let armed = false;
    sub.onWrite = r => { if (r.bytes === at[1].descriptor) armed = true; };
    h.s.onQuery = async (sql, _values, tx) => { if (armed && !tx && policyRead(sql)) { armed = false; await b.park(); } };
    const mark = {};
    try {
      held.release();
      assert.ok(await within(b.held, 3000), 'the descriptor\'s rights read is held');
      h.s.advance(31000);
      assert.equal((await h.request('GET', statusPath(held.study, held.id), { as: RAD })).body.attempts[0].state, 'unconfirmed');
      Object.assign(mark, { W0: sub.calls, B0: sub.bytes });
    } finally { b.open(); h.s.onQuery = null; }
    await assertNothingAfterFence(h, held, sub, mark, checkpoint, at);
    assert.equal(sub.bytes, at[1].descriptor, 'object 2\'s payload went out under its approvals; its descriptor did not');
  }
  // After a blocked drain: the receiver stops reading, the writer waits for 'drain' (holding no lock), a fence commits,
  // the receiver reads again - the next chunk is not supplied.
  {
    const h = await harness();
    const study = uid();
    own(h.s, study, 'inst-a', 'gateway');
    h.orthanc.store(dicom({ study, series: study + '.1', id: 'SYN-D', pixel: 8 * 1024 * 1024 }));
    h.orthanc.store(dicom({ study, series: study + '.2', id: 'SYN-D', pixel: 70 }));
    const id = randomUUID();
    assert.equal((await prepare(h, study, id)).status, 200);
    let response, closed;
    const ended = new Promise(resolve => { closed = resolve; });
    const req = http.request({ host: '127.0.0.1', port: h.port, path: archivePath(study, id), headers: { 'x-test-caller': JSON.stringify(RAD) } },
      res => { response = res; res.on('error', () => {}); res.on('close', closed); });
    req.on('error', () => closed());
    req.end();
    let sub;
    try {
      // Wait until the server's last write answered false and nothing more is written: it waits for the drain.
      let still = 0, seen = -1;
      for (let i = 0; i < 300 && still < 15; i++) {
        await sleep(20);
        sub = submitted(study, id);
        if (sub && sub.lastReturn === false && sub.calls === seen) still++; else still = 0;
        seen = sub ? sub.calls : -1;
      }
      assert.ok(sub && still >= 15 && sub.lastReturn === false, 'the writer waits for the receiver\'s drain');
      assert.equal(h.s.openTransactions, 0, 'no transaction is held while it waits');
      h.s.advance(31000);
      assert.equal((await h.request('GET', statusPath(study, id), { as: RAD })).body.attempts[0].state, 'unconfirmed');
    } finally { response?.resume(); }
    const mark = { W0: sub.calls, B0: sub.bytes };
    await ended;
    await sleep(80);
    assert.deepEqual([sub.calls - mark.W0, sub.bytes - mark.B0], [0, 0], 'no write after the drain resumed');
    assert.equal(sub.ended, false);
    const [a] = h.s.op(id).download.attempts;
    assert.deepEqual([a.state, a.objects.length, a.archiveSha256, a.responseFinished], ['unconfirmed', 0, null, false]);
    assert.equal(resultRows(h, a.attemptId).length, 1);
  }
  // A commit answer lost after a supply: that chunk went out once; the archive stops Unconfirmed and never sends it again.
  {
    const h = await harness();
    const held = await heldArchive(h);
    const at = layout(h, held.id), sub = submitted(held.study, held.id);
    const checkpoint = h.s.op(held.id).download.attempts[0].objects;
    let armed = false, lose = false;
    const mark = {};
    sub.onWrite = r => { if (r.bytes === at[1].payload && !armed) { armed = true; lose = true; Object.assign(mark, { W0: r.calls, B0: r.bytes }); } };
    h.s.onCommit = async tx => { if (lose && tx.casOperation === held.id) { lose = false; throw Object.assign(new Error('synthetic commit lost'), { code: 'P1017' }); } };
    try { held.release(); await held.archive; } finally { h.s.onCommit = null; }
    await sleep(80);
    assert.deepEqual([sub.calls - mark.W0, sub.bytes - mark.B0], [0, 0], 'nothing after the chunk whose commit answer was lost');
    const bytes = Buffer.concat(sub.chunks);
    assert.equal(bytes.length, at[1].payload, 'object 2\'s local header once, then nothing');
    const [a] = h.s.op(held.id).download.attempts;
    assert.deepEqual(a.objects, checkpoint);
    assert.deepEqual([a.state, a.archiveSha256, a.responseFinished], ['unconfirmed', null, false], 'an unknown commit after a supply is Unconfirmed');
    assert.equal(resultRows(h, a.attemptId).length, 1);
  }
  // An approval past its bound while the event loop is stalled (its timer has not run yet): the monotonic deadline read
  // right before the supply refuses it - nothing supplied, the transaction rolled back, the archive Unconfirmed.
  {
    const h = await harness();
    const held = await heldArchive(h);
    const at = layout(h, held.id), sub = submitted(held.study, held.id);
    const checkpoint = h.s.op(held.id).download.attempts[0].objects;
    let armed = false;
    const mark = {};
    sub.onWrite = r => { if (r.bytes === at[1].payload) { armed = true; Object.assign(mark, { W0: r.calls, B0: r.bytes }); } };
    const leaseBefore = () => h.s.op(held.id).download.attempts[0].leaseUntil;
    let lease = null;
    h.s.onQuery = async (sql, _values, tx) => {
      if (armed && tx && tx.casOperation === held.id && sql.includes('clock_timestamp() AS now')) {
        armed = false;
        lease = leaseBefore();
        const until = performance.now() + 5200;
        while (performance.now() < until) { /* the event loop stalls: no timer callback runs */ }
        h.s.advance(15000);   // a renewal in this late approval would show as a new lease
      }
    };
    try { held.release(); await held.archive; } finally { h.s.onQuery = null; }
    await sleep(80);
    assert.deepEqual([sub.calls - mark.W0, sub.bytes - mark.B0], [0, 0], 'the late approval supplied nothing');
    const [a] = h.s.op(held.id).download.attempts;
    assert.ok(lease !== null && a.leaseUntil === lease, 'its renewal rolled back with it');
    assert.deepEqual(a.objects, checkpoint);
    assert.deepEqual([a.state, a.archiveSha256, a.responseFinished], ['unconfirmed', null, false]);
  }
});

// ════════════════════════════════ round 3: the admin recovery within the target study's current reach (U4BB2-02) ════════════════════════════════

/** A may-have-written occupancy (contract 4.4): index 1 of an operation of `as`, its SOP stored meanwhile by another writer. */
async function mayHaveWritten(h, { as = TECH } = {}) {
  const study = uid(), sop = uid(), id = randomUUID();
  assert.equal((await h.send(dicom({ study, series: study + '.1', id: 'SYN-K' }), { id, index: 0, as })).status, 200);
  h.orthanc.onPost = (stored, o) => { if (stored.body?.Status === 'Success') o.store(dicom({ study, series: study + '.1', sop, id: 'SYN-OUTSIDE' })); o.onPost = null; };
  const k = await h.send(dicom({ study, series: study + '.1', sop, id: 'SYN-K' }), { id, index: 1, as });
  assert.deepEqual([k.status, k.body.code, k.body.writeDisposition], [409, 'SOP_UID_AMBIGUOUS', 'may-have-written']);
  return { id, study, index: 1 };
}
/** The two recoverable kinds: an expired unknown attempt and a may-have-written occupancy, each of operation owner `as`. */
const RECOVERABLE = {
  unknown: async (h, as = TECH) => { const a = await unknownAttempt(h, { as }); h.s.advance(31000); return { id: a.id, study: a.study, index: 0 }; },
  'may-have-written': (h, as = TECH) => mayHaveWritten(h, { as }),
};
const evidenceFor = (h, t) => ({ basis: 'orthanc-log-checked', checkedAt: h.s.file(t.id, t.index).attempts.at(-1).startedAt });
const scopeView = (h, t) => {
  const file = h.s.file(t.id, t.index);
  return { file, study: h.s.claim('study:' + t.study), sop: h.s.claim('sop:' + file.sopUid),
    rows: audits(h.s, 'dicom.import.recovery.request').length + audits(h.s, 'dicom.import.recovery.result').length + audits(h.s, 'dicom.import.result').length };
};
const OUT_OF_REACH = {
  restricted: (h, t) => { h.s.policies.set(ADMIN.sub, deniedPolicy); return () => h.s.policies.delete(ADMIN.sub); },
  moved: (h, t) => { const s = h.s.states.get(t.study), was = s.institutionId; s.institutionId = 'inst-b'; return () => { s.institutionId = was; }; },
  unassigned: (h, t) => { const s = h.s.states.get(t.study), was = s.institutionId; s.institutionId = null; return () => { s.institutionId = was; }; },
  'tele-received only': (h, t) => { const s = h.s.states.get(t.study); s.institutionId = 'inst-b'; s.teleInstitutionId = 'inst-a'; return () => { s.institutionId = 'inst-a'; s.teleInstitutionId = null; }; },
  deleted: (h, t) => { const s = h.s.states.get(t.study); h.s.states.delete(t.study); return () => h.s.states.set(t.study, s); },
};

test('S9U4-B54 the admin recovery binds to the target study\'s current reach (U4BB2-02): out of reach first - restricted, moved, unassigned, tele-received only, deleted - is the same 404 as no operation with no Orthanc read and no row; lost during the re-read it is 404 with nothing of the result written (the request row and the reading right stay); restored rights recover; another owner\'s operation of the same institution is recovered with its owner kept; a store that cannot answer is 503; a refused file without a study is 409 - for an unknown attempt and a may-have-written occupancy alike', async () => {
  for (const [kind, make] of Object.entries(RECOVERABLE)) {
    // Out of reach before anything: the 404 of an absent operation, byte for byte; nothing read at Orthanc, nothing written.
    for (const [mode, leave] of Object.entries(OUT_OF_REACH)) {
      const h = await harness();
      const t = await make(h);
      const missing = await recovery(h, randomUUID(), evidenceFor(h, t));
      const before = scopeView(h, t);
      const restore = leave(h, t);
      h.orthanc.calls.length = 0;
      const r = await recovery(h, t.id, evidenceFor(h, t), ADMIN, t.index);
      assert.deepEqual([r.status, r.body], [404, missing.body], `${kind} / ${mode}: the same 404 as no operation`);
      assert.deepEqual(h.orthanc.calls.map(c => c.path), ['/system'], `${kind} / ${mode}: only the readiness fact, no SOP or file read`);
      assert.deepEqual(scopeView(h, t), before, `${kind} / ${mode}: no recovery row, no result, holders unchanged`);
      // An evidence error does not show through either: still the 404.
      assert.equal((await recovery(h, t.id, { basis: 'admin-says-so', checkedAt: evidenceFor(h, t).checkedAt }, ADMIN, t.index)).status, 404, `${kind} / ${mode}: scope before evidence`);
      // Rights restored: the same admin recovers it.
      restore();
      const ok = await recovery(h, t.id, evidenceFor(h, t), ADMIN, t.index);
      assert.equal(ok.status, 200, `${kind} / ${mode}: restored rights recover (${JSON.stringify(ok.body)})`);
      assert.equal(h.s.claim('study:' + t.study).claim.heldByAttemptId, null);
    }
    // Lost during the Orthanc re-read: 404; the request row (and an unknown attempt's reading right) stay, nothing of the
    // result is written; once the study is back and the right has run out, the recovery goes through.
    for (const mode of ['moved', 'restricted']) {
      const h = await harness();
      const t = await make(h);
      const before = scopeView(h, t);
      let restore = null;
      h.orthanc.fault = call => { if (call.path === '/tools/lookup' && !restore) restore = OUT_OF_REACH[mode](h, t); return null; };
      const r = await recovery(h, t.id, evidenceFor(h, t), ADMIN, t.index);
      h.orthanc.fault = null;
      assert.deepEqual([r.status, r.body.message], [404, '반입 작업을 찾을 수 없습니다'], `${kind} / ${mode} meanwhile`);
      const after = scopeView(h, t);
      assert.deepEqual([audits(h.s, 'dicom.import.recovery.request').length, audits(h.s, 'dicom.import.recovery.result').length], [1, 0], 'the request row stays; no result row');
      assert.deepEqual([after.file.outcome, after.file.code, after.file.writeDisposition], [before.file.outcome, before.file.code, before.file.writeDisposition], 'the result unchanged');
      assert.deepEqual([after.study.claim.heldByAttemptId, after.sop.claim.heldByAttemptId], [before.study.claim.heldByAttemptId, before.sop.claim.heldByAttemptId], 'holders unchanged');
      const last = after.file.attempts.at(-1);
      assert.ok(last.recovery && last.recovery.resolvedAt === null, 'the request is on record, unresolved');
      if (kind === 'unknown') assert.ok(Date.parse(last.leaseUntil) > h.s.clock, 'the reading right taken while in reach stays and runs out');
      restore();
      if (kind === 'unknown') {
        assert.equal((await recovery(h, t.id, evidenceFor(h, t), ADMIN, t.index)).body.code, 'RECOVERY_NOT_APPLICABLE', 'its reading right still lives');
        h.s.advance(31000);
      }
      const again = await recovery(h, t.id, evidenceFor(h, t), ADMIN, t.index);
      assert.equal(again.status, 200, `${kind} / ${mode}: recovered once back in reach`);
    }
    // Lost between the first check and the request transaction: the request transaction checks it again - 404, not
    // even the request row, nothing read at Orthanc.
    {
      const h = await harness();
      const t = await make(h);
      const before = scopeView(h, t);
      let restore = null;
      h.s.onQuery = async (sql, _values, tx) => { if (!restore && tx && sql.includes('WHERE "claimKey" = ? FOR UPDATE')) restore = OUT_OF_REACH.moved(h, t); };
      h.orthanc.calls.length = 0;
      const r = await recovery(h, t.id, evidenceFor(h, t), ADMIN, t.index);
      h.s.onQuery = null;
      assert.ok(restore, 'moved while the request transaction took its locks');
      assert.deepEqual([r.status, h.orthanc.calls.map(c => c.path), scopeView(h, t)], [404, ['/system'], before], `${kind}: no request row, no Orthanc read`);
      restore();
    }
    // Lost during a re-read that itself failed: still that 404 (not the Orthanc answer); an unknown attempt's reading right stays.
    {
      const h = await harness();
      const t = await make(h);
      let restore = null;
      h.orthanc.fault = call => {
        if (call.path !== '/tools/lookup') return null;
        restore = restore ?? OUT_OF_REACH.moved(h, t);
        return { status: 500 };
      };
      const r = await recovery(h, t.id, evidenceFor(h, t), ADMIN, t.index);
      h.orthanc.fault = null;
      assert.deepEqual([r.status, r.body.message], [404, '반입 작업을 찾을 수 없습니다'], `${kind}: out of reach after a failed re-read`);
      if (kind === 'unknown') assert.ok(Date.parse(h.s.file(t.id, t.index).attempts.at(-1).leaseUntil) > h.s.clock, 'the reading right is not given back');
      restore();
    }
    // Another owner's operation of the admin's institution: recovered; the owner and the attempt's actor stay, the admin is
    // recorded as the recovery's.
    {
      const h = await harness();
      const t = await make(h, TECH2);
      const r = await recovery(h, t.id, evidenceFor(h, t), ADMIN, t.index);
      assert.equal(r.status, 200, `${kind}: another owner's operation`);
      const op = h.s.op(t.id), last = h.s.file(t.id, t.index).attempts.at(-1);
      assert.deepEqual([op.ownerSubject, op.actor, last.actor], [TECH2.sub, TECH2.actor, TECH2.actor]);
      assert.deepEqual([last.recovery.adminSubject, last.recovery.adminActor], [ADMIN.sub, ADMIN.actor]);
      const [row] = audits(h.s, 'dicom.import.recovery.result');
      assert.deepEqual([row.actor, row.detail.adminSubject], [ADMIN.actor, ADMIN.sub]);
      assert.ok(audits(h.s, 'dicom.import.result').filter(a => a.detail.operationId === t.id).every(a => a.detail.ownerSubject === TECH2.sub));
    }
    // A store that cannot answer the scope: 503, never a 404; nothing read, nothing written.
    for (const [what, fail] of [['StudyAccess policy', h => { h.s.onQuery = async sql => { if (policyRead(sql)) throw new Error('synthetic policy store down'); }; }],
      ['StudyState', h => { h.s.prisma.studyState.findUnique = async () => { throw new Error('synthetic StudyState store down'); }; }]]) {
      const h = await harness();
      const t = await make(h);
      const before = scopeView(h, t);
      fail(h);
      h.orthanc.calls.length = 0;
      const r = await recovery(h, t.id, evidenceFor(h, t), ADMIN, t.index);
      h.s.onQuery = null;
      assert.deepEqual([r.status, r.body.code], [503, 'IMPORT_STORAGE_UNAVAILABLE'], `${kind}: ${what} unreadable`);
      assert.ok(!JSON.stringify(r.body).includes('synthetic'), 'no store text');
      assert.deepEqual([h.orthanc.calls.map(c => c.path), scopeView(h, t)], [['/system'], before]);
    }
  }
  // A file the reader refused has no study: not a recovery target (409), never the out-of-reach 404.
  const h = await harness();
  const refused = await h.send(Buffer.from('not a dicom file at all'));
  assert.equal(refused.body.code, 'DICOM_NOT_PART10');
  const r = await recovery(h, refused.id, { basis: 'orthanc-log-checked', checkedAt: new Date(T0).toISOString() });
  assert.deepEqual([r.status, r.body.code], [409, 'RECOVERY_NOT_APPLICABLE']);
});

// ════════════════════════════════ round 3: a stored result bound to the attempt it rests on (U4BB2-03) ════════════════════════════════

test('S9U4-B55 a stored file result must rest on its last attempt by the transition table (U4BB2-03): Stored without attempts, with a last retryable or certain-no-write attempt, Stored/AlreadyStored swapped, a success after another final attempt and every combination the table does not allow are 503 IMPORT_STORAGE_UNAVAILABLE on GET and on the same file\'s POST, with the rows kept and nothing written; the legitimate transitions answer 200 - the retryable ones, RECOVERED_NO_OBJECT, a pre-attempt refusal after an older retryable attempt, AlreadyStored by lookup, Stored after an unknown transport, and PATIENT_ISSUER_CONFLICT after a retryable attempt when the issuer\'s institutions changed (no new attempt)', async () => {
  const STORAGE = [503, 'IMPORT_STORAGE_UNAVAILABLE'];
  const finished = (a, outcome, code, transport, extra = {}) => ({ ...a, phase: 'finished', finishedAt: a.startedAt, outcome, code, transport, ...extra });
  const second = a => ({ ...a, attemptId: randomUUID(), generation: 2 });
  const corruptions = [
    ['Stored with no attempt (ASTRA2-04)', e => { e.attempts = []; }],
    ['Stored after a last retryable certain-no-write attempt (ASTRA2-04)', e => { e.attempts = [finished(e.attempts[0], 'retryable', 'ORTHANC_UNAVAILABLE', 'certain-no-write')]; }],
    ['Stored on an attempt that ended AlreadyStored by lookup', e => { e.attempts = [finished(e.attempts[0], 'already-present', null, 'certain-no-write')]; }],
    ['Stored on an attempt that ended AlreadyStored by its POST (transport null)', e => { e.attempts = [finished(e.attempts[0], 'already-present', null, null)]; }],
    ['AlreadyStored on an attempt that ended Stored', e => { e.outcome = 'already-present'; }],
    ['Stored on a certain-no-write transport', e => { e.attempts[0].transport = 'certain-no-write'; }],
    ['Stored on an attempt that ended rejected', e => { e.attempts = [finished(e.attempts[0], 'rejected', 'SOP_CONTENT_CONFLICT', 'certain-no-write')]; }],
    ['Stored after an earlier Stored attempt', e => { e.attempts = [e.attempts[0], second(e.attempts[0])]; }],
    ['retryable IMPORT_ATTEMPT_EXPIRED with no attempt', e => { Object.assign(e, { outcome: 'retryable', code: 'IMPORT_ATTEMPT_EXPIRED' }); e.attempts = []; }],
    ['retryable ORTHANC_UNAVAILABLE on an attempt with a null transport', e => { Object.assign(e, { outcome: 'retryable', code: 'ORTHANC_UNAVAILABLE' }); e.attempts = [finished(e.attempts[0], 'retryable', 'ORTHANC_UNAVAILABLE', null)]; }],
    ['RECOVERED_NO_OBJECT without a resolved recovery', e => { Object.assign(e, { outcome: 'retryable', code: 'RECOVERED_NO_OBJECT' }); e.attempts = [finished(e.attempts[0], 'retryable', 'RECOVERED_NO_OBJECT', 'unknown')]; }],
    ['EXISTING_STUDY_IDENTITY_UNRESOLVED with no attempt', e => { Object.assign(e, { outcome: 'rejected', code: 'EXISTING_STUDY_IDENTITY_UNRESOLVED', writeDisposition: 'pre-write' }); e.attempts = []; }],
    ['may-have-written on a last retryable attempt', e => { Object.assign(e, { outcome: 'rejected', code: 'SOP_CONTENT_CONFLICT', writeDisposition: 'may-have-written' }); e.attempts = [finished(e.attempts[0], 'retryable', 'ORTHANC_UNAVAILABLE', 'certain-no-write')]; }],
    ['a refusal of the bytes after an attempt (only the issuer may change)', e => { Object.assign(e, { outcome: 'rejected', code: 'MODALITY_NOT_IMPORTABLE' }); e.attempts = [finished(e.attempts[0], 'retryable', 'ORTHANC_UNAVAILABLE', 'certain-no-write')]; }],
    ['unconfirmed on a dispatching attempt with an unknown transport', e => { Object.assign(e, { outcome: 'unconfirmed', code: 'IMPORT_UNCONFIRMED' }); e.attempts = [{ ...e.attempts[0], phase: 'dispatching', finishedAt: null, outcome: 'unconfirmed', code: 'IMPORT_UNCONFIRMED', transport: 'unknown' }]; }],
  ];
  for (const [name, corrupt] of corruptions) {
    const h = await harness();
    const bytes = dicom({ study: uid() });
    const first = await h.send(bytes);
    assert.deepEqual([first.status, first.body.outcome], [200, 'stored']);
    corrupt(h.s.ops.get(first.id).results[0]);
    const row = h.s.op(first.id), writes = h.s.writes, audited = h.s.audits.length, before = posts(h.orthanc);
    const status = await h.request('GET', '/api/dicom-import/' + first.id);
    assert.deepEqual([status.status, status.body.code], STORAGE, name + ': GET');
    const again = await h.send(bytes, { id: first.id });
    assert.deepEqual([again.status, again.body.code], STORAGE, name + ': the same file\'s POST');
    assert.deepEqual([h.s.op(first.id), h.s.writes, h.s.audits.length, posts(h.orthanc)], [row, writes, audited, before], name + ': kept as it is, nothing written');
  }
  const ok = async (h, id) => {
    const r = await h.request('GET', '/api/dicom-import/' + id);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.files;
  };
  // Row 3: retryable with the attempt's own code (the lookup failed before the write).
  {
    const h = await harness();
    h.orthanc.fault = call => (call.path === '/tools/lookup' ? { status: 500 } : null);
    const r = await h.send(dicom({ study: uid() }));
    h.orthanc.fault = null;
    assert.deepEqual([r.status, r.body.code, r.body.attempts[0].transport], [503, 'ORTHANC_UNAVAILABLE', 'certain-no-write']);
    assert.equal((await ok(h, r.id))[0].code, 'ORTHANC_UNAVAILABLE');
  }
  // Row 4: RECOVERED_NO_OBJECT after a resolved admin recovery; row 1 with an unknown transport after the re-check.
  {
    const h = await harness();
    const a = await unknownAttempt(h);
    h.s.advance(31000);
    assert.equal((await recovery(h, a.id, { basis: 'orthanc-restarted', checkedAt: a.attempt.startedAt })).body.code, 'RECOVERED_NO_OBJECT');
    assert.equal((await ok(h, a.id))[0].code, 'RECOVERED_NO_OBJECT');
    const b = await unknownAttempt(h, { stored: true });
    h.s.advance(31000);
    const [file] = await ok(h, b.id);
    assert.deepEqual([file.outcome, file.attempts[0].transport], ['stored', 'unknown'], 'reconciled by the GET, read again as Stored');
  }
  // Row 2: AlreadyStored by the pre-write lookup (certain-no-write).
  {
    const h = await harness();
    const study = uid(), bytes = dicom({ study });
    h.orthanc.store(bytes);
    own(h.s, study);
    const r = await h.send(bytes);
    assert.deepEqual([r.status, r.body.outcome, r.body.attempts[0].transport], [200, 'already-present', 'certain-no-write']);
    assert.equal((await ok(h, r.id))[0].outcome, 'already-present');
  }
  // Row 5: a pre-attempt refusal (STUDY_WRITE_PENDING) after an older retryable attempt of another code.
  {
    const h = await harness();
    const study = uid(), bytes = dicom({ study, series: study + '.1' });
    h.orthanc.fault = call => (call.path === '/tools/lookup' ? { status: 500 } : null);
    const first = await h.send(bytes);
    assert.equal(first.body.code, 'ORTHANC_UNAVAILABLE');
    h.orthanc.fault = call => (call.path === '/tools/lookup' ? { hang: true } : null);
    const holding = h.send(dicom({ study, series: study + '.1' }));
    await sleep(150);
    const pending = await h.send(bytes, { id: first.id });
    assert.deepEqual([pending.status, pending.body.code, pending.body.attempts.length], [409, 'STUDY_WRITE_PENDING', 1]);
    const [file] = await ok(h, first.id);
    assert.deepEqual([file.code, file.attempts[0].code], ['STUDY_WRITE_PENDING', 'ORTHANC_UNAVAILABLE']);
    h.orthanc.fault = null;
    void holding;
  }
  // Row 7, through the real path: attempt 1 ends retryable (lookup failed); then another institution gets the same issuer
  // alias, so the same bytes are refused by the precheck - no new attempt, the old one kept; GET 200, POST 409 (final,
  // also after the alias is reverted).
  {
    const institutions = [{ id: 'inst-a', name: 'Synthetic A', dicomNames: 'SYN A,SYNTHETIC-A' }, { id: 'inst-b', name: 'Synthetic B', dicomNames: 'SYN B' }];
    const h = await harness({ institutions });
    const bytes = dicom({ study: uid(), issuer: 'SYN A' });
    h.orthanc.fault = call => (call.path === '/tools/lookup' ? { status: 500 } : null);
    const first = await h.send(bytes);
    h.orthanc.fault = null;
    assert.deepEqual([first.status, first.body.code, first.body.attempts.length], [503, 'ORTHANC_UNAVAILABLE', 1]);
    const [attempt] = h.s.file(first.id, 0).attempts;
    h.s.institutions[1].dicomNames = 'SYN B,SYN A';
    const intents = audits(h.s, 'dicom.import.intent').length;
    const refused = await h.send(bytes, { id: first.id });
    assert.deepEqual([refused.status, refused.body.outcome, refused.body.code, refused.body.attempts.length], [409, 'rejected', 'PATIENT_ISSUER_CONFLICT', 1]);
    assert.deepEqual(h.s.file(first.id, 0).attempts, [attempt], 'the retryable attempt kept as it was, no new one');
    const [file] = await ok(h, first.id);
    assert.deepEqual([file.outcome, file.code, file.attempts.map(a => [a.outcome, a.code, a.transport])], ['rejected', 'PATIENT_ISSUER_CONFLICT', [['retryable', 'ORTHANC_UNAVAILABLE', 'certain-no-write']]]);
    assert.deepEqual((await h.send(bytes, { id: first.id })).status, 409, 'replayed');
    h.s.institutions[1].dicomNames = 'SYN B';
    const reverted = await h.send(bytes, { id: first.id });
    assert.deepEqual([reverted.status, reverted.body.code], [409, 'PATIENT_ISSUER_CONFLICT'], 'a final result stays final');
    assert.deepEqual([audits(h.s, 'dicom.import.intent').length, posts(h.orthanc)], [intents, 0], 'no new intent, no Orthanc write');
  }
});

// ════════════════════════════════ round 4: each approval stage bounded as a whole, on every completion (U4BB3-01) ════════════════════════════════

/** The contract's bound of one approval stage (REQ-S9-U4-08: each stage as a whole within 5 s, both within 10 s). */
const STAGE_MS = 5000;
/** The event loop held by synchronous work for ms: no timer callback runs meanwhile, and afterwards promise continuations run first. */
function stall(ms) {
  const until = performance.now() + ms;
  while (performance.now() < until) { /* the event loop is held */ }
}
const DESCRIPTOR_SIG = Buffer.from([0x50, 0x4b, 0x07, 0x08]);
const stateRead = sql => sql.includes('FROM "StudyState" WHERE uid = ? FOR SHARE');

/**
 * A held archive (object 1 supplied and checkpointed, object 2 held at its source) that a test releases: `armed` turns
 * true when object 2's local header is submitted, so the next approval met is that of object 2's first payload chunk;
 * take() records W0/B0 there. onHeader, if set, runs at that submission.
 */
async function atFirstPayload(h) {
  const held = await heldArchive(h);
  const at = layout(h, held.id), sub = submitted(held.study, held.id);
  const p = { held, at, sub, checkpoint: h.s.op(held.id).download.attempts[0].objects, mark: {}, armed: false, onHeader: null };
  p.take = () => { p.armed = false; Object.assign(p.mark, { W0: sub.calls, B0: sub.bytes }); };
  sub.onWrite = r => { if (r.bytes === at[1].payload) { p.armed = true; p.onHeader?.(); } };
  return p;
}

/**
 * The old attempt after an approval was held past its bound, from W0/B0 on: no write call and no byte, not one payload
 * byte of object 2, no later record (its descriptor, the manifest entry, the central directory, the end record), no
 * finish of the response; no archive hash, response not finished, exactly one result row. Its state and objects are
 * the caller's to check.
 */
async function assertNoSupplyAfter(h, held, sub, mark, at) {
  const answer = await held.archive;
  for (let i = 0; i < 100 && h.s.op(held.id).download.attempts[0].state === 'sending'; i++) await sleep(20);
  await sleep(80);
  assert.deepEqual([sub.calls - mark.W0, sub.bytes - mark.B0], [0, 0], 'no sink write call and no byte after the approval was held');
  const bytes = Buffer.concat(sub.chunks);
  assert.equal(bytes.length, sub.bytes);
  assert.equal(Math.max(0, sub.bytes - at[1].payload), 0, 'not one payload byte of object 2');
  assert.ok(!bytes.subarray(at[0].end).includes(DESCRIPTOR_SIG), 'no descriptor of object 2');
  assert.ok(!bytes.includes(Buffer.from('manifest.json')) && !bytes.includes(CENTRAL_SIG) && !bytes.includes(END_SIG), 'no manifest entry, central directory or end record');
  assert.deepEqual([sub.ended, answer.complete], [false, false], 'no finish of the response');
  const [a] = h.s.op(held.id).download.attempts;
  assert.deepEqual([a.archiveSha256, a.responseFinished], [null, false]);
  assert.equal(resultRows(h, a.attemptId).length, 1, 'exactly one result row');
  return a;
}
/** A stop of stage 1 is the rights': Incomplete with the writer's exact counts - object 1 as checkpointed, object 2 opened with nothing supplied. */
function assertRightsStop(a, checkpoint) {
  assert.equal(a.state, 'incomplete');
  assert.deepEqual(a.objects[0], checkpoint[0], 'the completed object as it was checkpointed');
  assert.deepEqual(a.objects.slice(1).map(o => [o.complete, o.bytesSupplied, o.sha256]), [[false, 0, null]], 'object 2 opened, not one byte of it supplied');
}
/** A stop of stage 2 is an unknown approval: Unconfirmed with the checkpoint committed before it, deep-equal (hashes, bytes, complete). */
function assertApprovalStop(a, checkpoint) {
  assert.deepEqual([a.state, a.objects], ['unconfirmed', checkpoint]);
}
/** The whole archive went out and the attempt is Sent. */
async function assertWhole(h, held, answer) {
  assert.equal(answer.bytes.length, Number(answer.headers['content-length']), 'the whole archive');
  await sleep(50);
  assert.deepEqual(h.s.op(held.id).download.attempts.map(a => [a.state, a.responseFinished]), [['sent', true]]);
}

test('S9U4-B56 approval stage 1 - the credential and the StudyAccess metadata outside the lock - is bounded as a whole (U4BB3-01): an answer after its deadline is never taken as one, whether the late answer or the stage\'s timer runs first, valid, refused or failed alike - no further write or byte, no stage 2, Incomplete with the exact counts (Unconfirmed when a fence came meanwhile); its reads share one deadline and now == deadline is expired; an answer within it goes on; a new attempt after the stop sends the whole archive', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });   // only the approvals before each chunk act, never the 10 s timer
  // N1 and its siblings, the late answer first: object 2's first payload approval meets its StudyAccess read (valid) or
  // its credential check (refused: the token expired meanwhile; failed) 5200 ms late with the event loop held, so the
  // promise continuation runs before the stage's timer could.
  for (const [name, where, answer] of [['valid (N1)', 'read', () => {}], ['refused', 'credential', h => h.s.expiredTokens.add('tok:' + RAD.sub)],
    ['failed', 'credential', () => { throw new Error('synthetic provider failure'); }]]) {
    const h = await harness();
    const p = await atFirstPayload(h);
    let elapsed = null;
    const late = () => { p.take(); const begun = performance.now(); stall(5200); elapsed = performance.now() - begun; answer(h); };
    if (where === 'read') h.s.onQuery = async (sql, _values, tx) => { if (p.armed && !tx && policyRead(sql)) late(); };
    else h.s.onAuth = async () => { if (p.armed) late(); };
    try { p.held.release(); await p.held.archive; } finally { h.s.onQuery = null; h.s.onAuth = null; p.held.release(); }
    assert.ok(elapsed >= 5200 && p.mark.B0 === p.at[1].payload, name + ': held 5200 ms after object 1\'s checkpoint and object 2\'s local header');
    assertRightsStop(await assertNoSupplyAfter(h, p.held, p.sub, p.mark, p.at), p.checkpoint);
    if (name !== 'valid (N1)') continue;
    // A new attempt after the stop: the whole archive, Sent; the stopped attempt stays as it was.
    const retry = await h.request('GET', archivePath(p.held.study, p.held.id), { as: RAD });
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.bytes.length, Number(retry.headers['content-length']));
    await sleep(50);
    assert.deepEqual(h.s.op(p.held.id).download.attempts.map(a => a.state), ['incomplete', 'sent']);
  }
  // One deadline for the stage's reads: the credential check and the StudyAccess read each answer in 2600 ms - in time
  // alone, 5200 ms together - with no timer able to run meanwhile.
  {
    const h = await harness();
    const p = await atFirstPayload(h);
    let second = false;
    h.s.onAuth = async () => { if (p.armed) { p.take(); second = true; stall(2600); } };
    h.s.onQuery = async (sql, _values, tx) => { if (second && !tx && policyRead(sql)) { second = false; stall(2600); } };
    try { p.held.release(); await p.held.archive; } finally { h.s.onQuery = null; h.s.onAuth = null; p.held.release(); }
    assertRightsStop(await assertNoSupplyAfter(h, p.held, p.sub, p.mark, p.at), p.checkpoint);
  }
  // Within the deadline: the same StudyAccess read answering valid after 4000 ms goes on - the whole archive, Sent.
  {
    const h = await harness();
    const p = await atFirstPayload(h);
    h.s.onQuery = async (sql, _values, tx) => { if (p.armed && !tx && policyRead(sql)) { p.take(); stall(4000); } };
    let answer;
    try { p.held.release(); answer = await p.held.archive; } finally { h.s.onQuery = null; p.held.release(); }
    await assertWhole(h, p.held, answer);
  }
  // The deadline's edge, on the process's monotonic clock held still by the test from object 2's local header on (its
  // timers stay real): the StudyAccess answer at exactly start + 5000 ms is expired - nothing more, Incomplete; at
  // start + 4999 ms it is in time - the whole archive, Sent.
  for (const [offset, expected] of [[STAGE_MS, 'expired'], [STAGE_MS - 1, 'in time']]) {
    const h = await harness();
    const p = await atFirstPayload(h);
    const real = performance.now.bind(performance);
    let frozen = null, start = null;
    const clock = t.mock.method(performance, 'now', () => frozen ?? real());
    p.onHeader = () => { frozen = start = real(); };
    h.s.onQuery = async (sql, _values, tx) => { if (p.armed && !tx && policyRead(sql)) { p.take(); frozen = start + offset; } };
    let answer;
    try { p.held.release(); answer = await p.held.archive; } finally { h.s.onQuery = null; clock.mock.restore(); p.held.release(); }
    if (expected === 'in time') await assertWhole(h, p.held, answer);
    else assertRightsStop(await assertNoSupplyAfter(h, p.held, p.sub, p.mark, p.at), p.checkpoint);
  }
  // The timer first: the stage's check is held past its deadline with the event loop free, so its timer stops the
  // archive while the check is still held; then the check answers - valid, refused or failed: nothing supplied, no
  // stage 2, the attempt not reopened. A fence committed while the check was held makes it Unconfirmed (the fence wins).
  // The four archives run side by side, one 5 s wait for all.
  const runs = [];
  try {
    for (const [name, where, answer, fence] of [['valid', 'read', () => {}], ['refused', 'credential', h => h.s.expiredTokens.add('tok:' + RAD.sub)],
      ['failed', 'read', () => { throw new Error('synthetic store failure'); }], ['valid after a fence', 'read', () => {}, true]]) {
      const h = await harness();
      const p = await atFirstPayload(h);
      const b = barrier();
      const hold = async () => { p.take(); await b.park(); answer(h); };
      if (where === 'read') h.s.onQuery = async (sql, _values, tx) => { if (p.armed && !tx && policyRead(sql)) await hold(); };
      else h.s.onAuth = async () => { if (p.armed) await hold(); };
      runs.push({ name, h, p, b, fence });
      p.held.release();
      assert.ok(await within(b.held, 3000), name + ': the check is held');
      if (fence) {
        h.s.advance(31000);
        assert.equal((await h.request('GET', statusPath(p.held.study, p.held.id), { as: RAD })).body.attempts[0].state, 'unconfirmed', 'the fence committed');
      }
    }
    for (const r of runs) assert.ok(await within(r.p.held.archive, 8000), r.name + ': the stage\'s timer stopped the archive while its check was held');
  } finally { for (const r of runs) { r.b.open(); r.h.s.onQuery = null; r.h.s.onAuth = null; r.p.held.release(); } }
  for (const r of runs) {
    const a = await assertNoSupplyAfter(r.h, r.p.held, r.p.sub, r.p.mark, r.p.at);
    if (r.fence) assertApprovalStop(a, r.p.checkpoint); else assertRightsStop(a, r.p.checkpoint);
  }
  // A new attempt after the timeout sends the whole archive; the late valid answer reopened nothing. (Its own fake
  // Orthanc again: the variable belongs to the harness made last.)
  const [{ h, p }] = runs;
  process.env.ORTHANC_URL = 'http://127.0.0.1:' + h.orthanc.server.address().port;
  const retry = await h.request('GET', archivePath(p.held.study, p.held.id), { as: RAD });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.bytes.length, Number(retry.headers['content-length']));
  await sleep(50);
  assert.deepEqual(h.s.op(p.held.id).download.attempts.map(a => a.state), ['incomplete', 'sent']);
});

test('S9U4-B57 approval stage 2 - from the wait for its lock to its commit\'s answer - is bounded as a whole (U4BB3-01): a rights answer under the lock after the deadline is an expired approval, valid, refused or failed alike, whether the late answer or the stage\'s timer runs first - no further write or byte, Unconfirmed with the checkpoint as it was (N2); its reads share one deadline and now == deadline is expired; a refusal within the deadline stays the rights\' answer (Incomplete) and a valid answer within it goes on', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  // N2 and its siblings, the late answer first: the StudyAccess read inside object 2's first payload approval, under the
  // operation row lock, answers 5200 ms late with the event loop held - refusing, valid, or failing.
  for (const [name, answer] of [['refusal (N2)', h => h.s.policies.set(RAD.sub, deniedPolicy)], ['valid', () => {}],
    ['failure', () => { throw new Error('synthetic store failure'); }]]) {
    const h = await harness();
    const p = await atFirstPayload(h);
    let elapsed = null;
    h.s.onQuery = async (sql, _values, tx) => {
      if (p.armed && tx && policyRead(sql)) { p.take(); const begun = performance.now(); stall(5200); elapsed = performance.now() - begun; answer(h); }
    };
    try { p.held.release(); await p.held.archive; } finally { h.s.onQuery = null; p.held.release(); }
    assert.ok(elapsed >= 5200 && p.mark.B0 === p.at[1].payload, name + ': held 5200 ms after object 1\'s checkpoint and object 2\'s local header');
    assertApprovalStop(await assertNoSupplyAfter(h, p.held, p.sub, p.mark, p.at), p.checkpoint);
  }
  // Within the deadline the same refusal after 4000 ms is the rights' answer: Incomplete with the exact counts.
  {
    const h = await harness();
    const p = await atFirstPayload(h);
    h.s.onQuery = async (sql, _values, tx) => { if (p.armed && tx && policyRead(sql)) { p.take(); stall(4000); h.s.policies.set(RAD.sub, deniedPolicy); } };
    try { p.held.release(); await p.held.archive; } finally { h.s.onQuery = null; p.held.release(); }
    assertRightsStop(await assertNoSupplyAfter(h, p.held, p.sub, p.mark, p.at), p.checkpoint);
  }
  // One deadline for the stage's reads: the StudyState read and the StudyAccess read under the lock, 2600 ms each.
  {
    const h = await harness();
    const p = await atFirstPayload(h);
    let second = false;
    h.s.onQuery = async (sql, _values, tx) => {
      if (p.armed && tx && stateRead(sql)) { p.take(); second = true; stall(2600); }
      else if (second && tx && policyRead(sql)) { second = false; stall(2600); }
    };
    try { p.held.release(); await p.held.archive; } finally { h.s.onQuery = null; p.held.release(); }
    assertApprovalStop(await assertNoSupplyAfter(h, p.held, p.sub, p.mark, p.at), p.checkpoint);
  }
  // The deadline's edge on the monotonic clock held still from object 2's local header (stage 2 then starts at that
  // instant): the StudyAccess answer under the lock at exactly start + 5000 ms is expired - Unconfirmed; at + 4999 ms
  // it is in time - the whole archive, Sent.
  for (const [offset, expected] of [[STAGE_MS, 'expired'], [STAGE_MS - 1, 'in time']]) {
    const h = await harness();
    const p = await atFirstPayload(h);
    const real = performance.now.bind(performance);
    let frozen = null, start = null;
    const clock = t.mock.method(performance, 'now', () => frozen ?? real());
    p.onHeader = () => { frozen = start = real(); };
    h.s.onQuery = async (sql, _values, tx) => { if (p.armed && tx && policyRead(sql)) { p.take(); frozen = start + offset; } };
    let answer;
    try { p.held.release(); answer = await p.held.archive; } finally { h.s.onQuery = null; clock.mock.restore(); p.held.release(); }
    if (expected === 'in time') await assertWhole(h, p.held, answer);
    else assertApprovalStop(await assertNoSupplyAfter(h, p.held, p.sub, p.mark, p.at), p.checkpoint);
  }
  // The timer first: the read under the lock held past the deadline with the event loop free; the stage's timer stops
  // the archive; then the read answers valid, refused or failed - nothing supplied, nothing of it committed, Unconfirmed.
  const runs = [];
  try {
    for (const [name, answer] of [['valid', () => {}], ['refusal', h => h.s.policies.set(RAD.sub, deniedPolicy)], ['failure', () => { throw new Error('synthetic store failure'); }]]) {
      const h = await harness();
      const p = await atFirstPayload(h);
      const b = barrier();
      h.s.onQuery = async (sql, _values, tx) => { if (p.armed && tx && policyRead(sql)) { p.take(); await b.park(); answer(h); } };
      runs.push({ name, h, p, b });
      p.held.release();
      assert.ok(await within(b.held, 3000), name + ': the read under the lock is held');
    }
    for (const r of runs) assert.ok(await within(r.p.held.archive, 8000), r.name + ': the stage\'s timer stopped the archive while its read was held');
  } finally { for (const r of runs) { r.b.open(); r.h.s.onQuery = null; r.p.held.release(); } }
  for (const r of runs) assertApprovalStop(await assertNoSupplyAfter(r.h, r.p.held, r.p.sub, r.p.mark, r.p.at), r.p.checkpoint);
});

test('S9U4-B58 the renewal without a chunk and the commit\'s answer complete stage 2 too (U4BB3-01): a 10 s renewal that runs past its deadline is rolled back when its transaction finds it, and is an expired approval when only its commit\'s answer is late or its timer runs first - Unconfirmed, the checkpoint as it was, no further supply; a chunk whose commit answer - success or failure - comes late went out once and nothing follows it; a refusal that meets a lost lease, and a credential stage past its bound after the renewal fenced the attempt, are Unconfirmed (the fence wins)', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  // The 10 s renewal (no chunk) of an archive held at object 2's source; the DB clock 10 s on, so a renewal shows as a
  // new lease. Its own write stalls 5200 ms: the transaction finds the stage expired after the write and rolls it back.
  // Its commit's answer comes 5200 ms late: the renewal committed (it is not claimed rolled back), its answer is not
  // taken. Its row read is held with the event loop free: the timer stops the archive; the released read renews nothing.
  for (const mode of ['its write stalls', 'its commit answer is late', 'its timer runs first']) {
    const h = await harness();
    const held = await heldArchive(h);
    const at = layout(h, held.id), sub = submitted(held.study, held.id);
    const checkpoint = h.s.op(held.id).download.attempts[0].objects;
    h.s.advance(10000);
    const lease = h.s.op(held.id).download.attempts[0].leaseUntil;
    const mark = { W0: sub.calls, B0: sub.bytes };
    const b = barrier();
    let armed = true;
    if (mode === 'its write stalls') h.s.failNextWrite = () => { if (armed) { armed = false; stall(5200); } return false; };
    if (mode === 'its commit answer is late') h.s.onCommitted = async tx => { if (armed && tx.casOperation === held.id) { armed = false; stall(5200); } };
    if (mode === 'its timer runs first') h.s.onQuery = async (sql, _values, tx) => { if (armed && tx && casSql(sql)) { armed = false; await b.park(); } };
    try {
      t.mock.timers.tick(10000);
      assert.ok(await within(held.archive, 8000), mode + ': the renewal\'s verdict stopped the archive at its held source');
    } finally { b.open(); h.s.failNextWrite = null; h.s.onCommitted = null; h.s.onQuery = null; held.release(); }
    assert.equal(armed, false, mode + ': the renewal met the hold');
    const a = await assertNoSupplyAfter(h, held, sub, mark, at);
    assertApprovalStop(a, checkpoint);
    if (mode === 'its commit answer is late') assert.ok(Date.parse(a.leaseUntil) > Date.parse(lease), 'the late renewal had committed');
    else assert.equal(a.leaseUntil, lease, mode + ': the renewal rolled back with its transaction');
  }
  // A chunk approval whose commit answer comes late after its supply under the lock - a success, or the commit itself
  // failing: the chunk went out exactly once, nothing after it, Unconfirmed with the checkpoint as it was. The late
  // answer first (the event loop held 5200 ms), then the timer first (the answer held 5500 ms with the loop free).
  const commits = [];
  const lateCommit = async (kind, order) => {
    const h = await harness();
    const p = await atFirstPayload(h);
    p.onHeader = () => Object.assign(p.mark, { W0: p.sub.calls, B0: p.sub.bytes });
    const wait = () => (order === 'late answer first' ? stall(5200) : sleep(5500));
    // The payload approval's transaction: the first chunk check after object 2's local header.
    h.s.onQuery = async (sql, _values, tx) => { if (p.armed && tx && casSql(sql)) { p.armed = false; tx.watched = true; } };
    if (kind === 'success') h.s.onCommitted = async tx => { if (tx.watched) await wait(); };
    else h.s.onCommit = async tx => { if (tx.watched) { await wait(); throw Object.assign(new Error('synthetic commit lost'), { code: 'P1017' }); } };
    p.held.release();
    commits.push({ name: kind + ', ' + order, h, p });
  };
  const assertOnce = async ({ name, h, p }) => {
    const answer = await p.held.archive;
    for (let i = 0; i < 100 && h.s.op(p.held.id).download.attempts[0].state === 'sending'; i++) await sleep(20);
    await sleep(80);
    h.s.onQuery = null; h.s.onCommit = null; h.s.onCommitted = null;
    assert.equal(p.mark.B0, p.at[1].payload, name);
    assert.equal(p.sub.calls - p.mark.W0, 1, name + ': the approved chunk went out once');
    const bytes = Buffer.concat(p.sub.chunks), chunk = bytes.subarray(p.at[1].payload);
    assert.ok(chunk.length > 0 && chunk.equals(p.held.second.subarray(0, chunk.length)), name + ': it is the start of object 2, once');
    assert.ok(!bytes.includes(Buffer.from('manifest.json')) && !bytes.includes(CENTRAL_SIG) && !bytes.includes(END_SIG), name + ': no later record');
    assert.deepEqual([p.sub.ended, answer.complete], [false, false], name + ': no finish');
    const [a] = h.s.op(p.held.id).download.attempts;
    assertApprovalStop(a, p.checkpoint);
    assert.deepEqual([a.archiveSha256, a.responseFinished, resultRows(h, a.attemptId).length], [null, false, 1], name);
  };
  for (const kind of ['success', 'failure']) { await lateCommit(kind, 'late answer first'); await assertOnce(commits.pop()); }
  for (const kind of ['success', 'failure']) await lateCommit(kind, 'timer first');
  for (const c of commits) await assertOnce(c);
  // The fence wins. A refusal under the lock while the DB clock passed the lease: the approval's lease check fences it -
  // Unconfirmed with the checkpoint as it was, not Incomplete.
  {
    const h = await harness();
    const p = await atFirstPayload(h);
    h.s.onQuery = async (sql, _values, tx) => { if (p.armed && tx && policyRead(sql)) { p.take(); h.s.policies.set(RAD.sub, deniedPolicy); h.s.advance(31000); } };
    try { p.held.release(); await p.held.archive; } finally { h.s.onQuery = null; p.held.release(); }
    assertApprovalStop(await assertNoSupplyAfter(h, p.held, p.sub, p.mark, p.at), p.checkpoint);
  }
  // The 10 s renewal fences the attempt - its stage 2 runs 5200 ms past its bound - while a chunk's credential stage is
  // held past its own bound, whose timer then runs: the rights stop that comes second does not undo the fence.
  {
    const h = await harness();
    const p = await atFirstPayload(h);
    const b = barrier();
    let renewal = false;
    h.s.onQuery = async (sql, _values, tx) => {
      if (p.armed && !tx && policyRead(sql)) { p.take(); await b.park(); }
      else if (renewal && tx && casSql(sql)) { renewal = false; stall(5200); }
    };
    try {
      p.held.release();
      assert.ok(await within(b.held, 3000), 'the chunk\'s credential stage is held');
      renewal = true;
      t.mock.timers.tick(10000);
      assert.ok(await within(p.held.archive, 8000), 'the archive stopped');
    } finally { b.open(); h.s.onQuery = null; p.held.release(); }
    assert.equal(renewal, false, 'the renewal met the hold');
    assertApprovalStop(await assertNoSupplyAfter(h, p.held, p.sub, p.mark, p.at), p.checkpoint);
  }
});

// ════════════════════════════════ round 5: an unknown approval is never lost - to a rights stop, to the close, or between two of its own checks (U4BB4-01/04/03/05) ════════════════════════════════

/** The attempt once its close committed: the close waits for every approval still running, each within its own stage deadlines. */
async function closed(h, id, index = 0, ms = 9000) {
  for (let waited = 0; waited < ms && h.s.op(id).download.attempts[index].state === 'sending'; waited += 20) await sleep(20);
  return h.s.op(id).download.attempts[index];
}
/** From W0 (object 2's local header) on: exactly one write, the start of object 2's payload; no later record and no finish. */
function assertOneChunk(p, answer, name) {
  assert.equal(p.sub.calls - p.mark.W0, 1, name + ': the chunk approved before the stop went out once');
  const bytes = Buffer.concat(p.sub.chunks), chunk = bytes.subarray(p.at[1].payload);
  assert.ok(chunk.length > 0 && chunk.equals(p.held.second.subarray(0, chunk.length)), name + ': it is the start of object 2');
  assert.ok(!bytes.includes(Buffer.from('manifest.json')) && !bytes.includes(CENTRAL_SIG) && !bytes.includes(END_SIG), name + ': no later record');
  assert.deepEqual([p.sub.ended, answer.complete], [false, false], name + ': no finish');
  return chunk.length;
}
/**
 * The archive's next stage-2 transaction - the 10 s renewal once the test ticks it, the archive held at its source - is
 * watched: it commits and releases its locks, and its commit's answer comes back only when the barrier opens, as a success
 * or as `failure` (committed, the answer lost on its way back). `deny`: that transaction's StudyAccess read refuses (the
 * policy restored before its answer, so the writer's own approvals still pass).
 */
function heldAnswer(h, { failure = null, deny = false } = {}) {
  const b = barrier();
  let armed = true, answered = false;
  h.s.onQuery = async (sql, _values, tx) => {
    if (armed && tx && casSql(sql)) { armed = false; tx.watched = true; }
    else if (deny && tx?.watched && policyRead(sql)) h.s.policies.set(RAD.sub, deniedPolicy);
  };
  h.s.onCommitted = async tx => {
    if (!tx.watched) return;
    if (deny) h.s.policies.delete(RAD.sub);
    await b.park();
    answered = true;
    if (failure) throw failure;
  };
  return { ...b, answered: () => answered };
}
/** While an approval's answer is outstanding the attempt is not closed as anything that answer could contradict. */
function assertOpenOrUnconfirmed(a, name) {
  assert.ok(['sending', 'unconfirmed'].includes(a.state), name + ': with an approval\'s answer outstanding the attempt is not closed ' + a.state);
}
const intents = (h, attemptId) => audits(h.s, 'original.download.intent').filter(a => a.detail.attemptId === attemptId);

/**
 * Object 2's first payload approval supplies its chunk under the lock and its COMMIT is held (its row lock with it) while
 * the 10 s renewal meets a refused credential; the commit then fails (or, the control, is confirmed). `order`: the rights
 * stop first, or the commit failure first (the renewal's credential check held until after it).
 */
async function commitWithRightsStop(t, order) {
  {
    const h = await harness();
    const p = await atFirstPayload(h);
    const commit = barrier(), rights = barrier();
    let refused = false;
    p.onHeader = () => Object.assign(p.mark, { W0: p.sub.calls, B0: p.sub.bytes });
    // Object 2's first payload approval: the chunk supplied under its lock, then its COMMIT held (its row lock with it).
    h.s.onQuery = async (sql, _values, tx) => { if (p.armed && tx && casSql(sql)) { p.armed = false; tx.watched = true; } };
    h.s.onCommit = async tx => {
      if (!tx.watched) return;
      await commit.park();
      if (order !== 'commit confirmed (control)') throw Object.assign(new Error('synthetic commit lost'), { code: 'P1017' });
    };
    let answer;
    try {
      p.held.release();
      assert.ok(await within(commit.held, 3000), order + ': the payload chunk supplied under its lock, its commit held');
      // The 10 s renewal meets a refused credential: at once, or held until after the commit failed.
      h.s.onAuth = async () => {
        if (order === 'commit failure first') await rights.park();
        refused = true;
        throw new common.UnauthorizedException('synthetic rights refusal');
      };
      t.mock.timers.tick(10000);
      if (order === 'commit failure first') {
        assert.ok(await within(rights.held, 3000), order + ': the renewal\'s credential check is held');
        commit.open();
        await sleep(150);
        rights.open();
      } else {
        for (let i = 0; i < 100 && !refused; i++) await sleep(10);
        assert.ok(refused, order + ': the renewal stopped the attempt on its rights while the commit was held');
        await sleep(50);
        commit.open();
      }
      answer = await p.held.archive;
    } finally { commit.open(); rights.open(); p.held.release(); h.s.onQuery = null; h.s.onAuth = null; h.s.onCommit = null; }
    const a = await closed(h, p.held.id);
    const supplied = assertOneChunk(p, answer, order);
    assert.deepEqual([a.archiveSha256, a.responseFinished, resultRows(h, a.attemptId).length], [null, false, 1], order);
    if (order === 'commit confirmed (control)') {
      assert.equal(a.state, 'incomplete', 'a commit confirmed in time with a rights stop is not made unknown');
      assert.deepEqual(a.objects[0], p.checkpoint[0]);
      assert.deepEqual(a.objects.slice(1).map(o => [o.complete, o.bytesSupplied, o.sha256]), [[false, supplied, null]], 'the exact counts: object 2\'s supplied chunk');
    } else assertApprovalStop(a, p.checkpoint);
  }
}

test('S9U4-B59 probe-unknown-after-rights (U4BB4-01): a chunk\'s commit that fails after a renewal already stopped the attempt on its rights is an unknown approval - Unconfirmed with the checkpoint as it was, that chunk supplied once and nothing after it, one result row; the rights stop never stands for it', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  await commitWithRightsStop(t, 'rights stop first');
});

test('S9U4-B60 the other order and the control (U4BB4-01): the commit failure first, the rights stop after it - Unconfirmed the same; the commit confirmed in time with the rights stop stays Incomplete with the exact counts (a rights stop is never made unknown wholesale)', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  await commitWithRightsStop(t, 'commit failure first');
  await commitWithRightsStop(t, 'commit confirmed (control)');
});

/**
 * The 10 s renewal of an archive held at object 2's source commits and its answer is held; then the writer stops on the
 * rights (every later credential check refused) or finishes, and the answer - an error, a success, or the renewal's own
 * rights refusal - comes back after that (or, answerFirst, before the writer goes on).
 */
async function outstandingRenewal(t, name, writer, outcome, answerFirst) {
  {
    const h = await harness();
    const held = await heldArchive(h);
    const sub = submitted(held.study, held.id);
    const checkpoint = h.s.op(held.id).download.attempts[0].objects;
    const r = heldAnswer(h, { failure: outcome === 'error' ? new Error('synthetic renewal answer lost') : null, deny: outcome === 'refusal' });
    let answer, before = null, lastCheckpoint = null;
    try {
      t.mock.timers.tick(10000);
      assert.ok(await within(r.held, 3000), name + ': the renewal committed; its answer held after its locks were released');
      if (answerFirst) { r.open(); for (let i = 0; i < 100 && !r.answered(); i++) await sleep(10); await sleep(50); }
      if (writer === 'rights') h.s.onAuth = async () => { throw new common.UnauthorizedException('synthetic rights refusal'); };
      held.release();
      answer = await held.archive;
      if (!answerFirst) {
        await sleep(300);
        before = h.s.op(held.id).download.attempts[0];
        lastCheckpoint = before.objects;
        assertOpenOrUnconfirmed(before, name);
        r.open();
      }
    } finally { r.open(); held.release(); h.s.onQuery = null; h.s.onAuth = null; }
    const a = await closed(h, held.id);
    h.s.onCommitted = null;
    assert.equal(resultRows(h, a.attemptId).length, 1, name + ': one result row');
    if (outcome === 'error') {
      assert.deepEqual([a.state, a.archiveSha256, a.responseFinished], ['unconfirmed', null, false], name);
      assert.deepEqual(a.objects, writer === 'finish' ? lastCheckpoint : checkpoint, name + ': the checkpoint committed before the close');
    } else if (writer === 'finish' && outcome === 'success') {
      assert.equal(answer.bytes.length, Number(answer.headers['content-length']), name + ': the whole archive');
      assert.deepEqual([a.state, a.responseFinished, a.archiveSha256], ['sent', true, createHash('sha256').update(answer.bytes).digest('hex')], name);
    } else if (writer === 'finish') {
      assert.deepEqual([a.state, a.archiveSha256, a.responseFinished], ['incomplete', null, false], name + ': a rights stop after the finish is Incomplete');
      assert.ok(a.objects.length === 2 && a.objects.every(o => o.complete), name + ': the writer\'s exact counts');
    } else assertRightsStop(a, checkpoint);
    if (outcome !== 'error' || writer !== 'finish') return;
    // The HTTP finish did happen; the record keeps the supply unknown and claims nothing taken back. A new attempt then
    // sends the whole archive with its own intent and result rows; the closed one stays as it was.
    assert.deepEqual([answer.complete, sub.ended], [true, true]);
    const retry = await h.request('GET', archivePath(held.study, held.id), { as: RAD });
    assert.equal(retry.bytes.length, Number(retry.headers['content-length']));
    await closed(h, held.id, 1);
    const attempts = h.s.op(held.id).download.attempts;
    assert.deepEqual(attempts.map(x => x.state), ['unconfirmed', 'sent']);
    assert.deepEqual(attempts[0], a, 'the closed attempt unchanged');
    assert.deepEqual([intents(h, attempts[1].attemptId).length, resultRows(h, attempts[1].attemptId).length, resultRows(h, a.attemptId).length], [1, 1, 1]);
  }
}

test('S9U4-B61 probe-renewal-answer-after-close (U4BB4-04): the renewal\'s answer still out when the writer stops on the rights - the attempt is not closed Incomplete before it; the answer an error: Unconfirmed with the checkpoint committed before the close, one result row', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  await outstandingRenewal(t, 'writer stopped on the rights, the answer an error', 'rights', 'error', false);
});

test('S9U4-B62 probe-renewal-answer-after-finish (U4BB4-04): the renewal\'s answer still out when the writer finishes - never Sent before it; the answer an error: Unconfirmed, no archive hash, response not finished, the last checkpoint, one result row (the HTTP finish did happen and is not called taken back); a new attempt then sends the whole archive with its own intent and result rows', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  await outstandingRenewal(t, 'writer finished, the answer an error', 'finish', 'error', false);
});

test('S9U4-B63 the controls of an outstanding renewal (U4BB4-04): a success within its deadline after a rights stop leaves Incomplete with the exact counts and after a finish Sent with the archive hash; the renewal\'s own rights refusal within its deadline after a finish is Incomplete; answered before the writer goes on - a success then a rights stop Incomplete, an error Unconfirmed', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  for (const [name, writer, outcome, answerFirst] of [
    ['writer stopped on the rights, the answer a success in time', 'rights', 'success', false],
    ['the success answered first, then the rights stop', 'rights', 'success', true],
    ['the error answered first', 'rights', 'error', true],
    ['writer finished, the answer a success in time', 'finish', 'success', false],
    ['writer finished, the renewal refused in time', 'finish', 'refusal', false],
  ]) await outstandingRenewal(t, name, writer, outcome, answerFirst);
});

/**
 * Renewals whose answers are held, one archive each, side by side on one tick; each then plays its order of the writer's
 * finish, the answer and (where named) the result row's write, held at its audit insert. Every one must end Unconfirmed,
 * its result row saying the same.
 */
async function outstandingSideBySide(t, names) {
  const runs = [];
  const closingHeld = h => {
    const b = barrier();
    const transaction = h.s.prisma.$transaction;
    h.s.prisma.$transaction = (fn, options) => transaction(async tx => {
      const create = tx.auditLog.create;
      tx.auditLog.create = async args => { if (args.data.action === 'original.download.result') await b.park(); return create(args); };
      return fn(tx);
    }, options);
    return { ...b, restore: () => { h.s.prisma.$transaction = transaction; } };
  };
  try {
    for (const name of names) {
      const h = await harness();
      const held = await heldArchive(h);
      const r = heldAnswer(h, { failure: name.includes('error') ? new Error('synthetic renewal answer lost') : null });
      const closing = name.includes('result') ? closingHeld(h) : null;
      runs.push({ name, h, held, r, closing });
    }
    const began = Date.now();
    t.mock.timers.tick(10000);
    for (const x of runs) assert.ok(await within(x.r.held, 3000), x.name + ': the renewal\'s answer is held');
    await Promise.all(runs.map(async x => {
      const { name, h, held, r, closing } = x;
      if (name === 'a success after its deadline') {
        // The writer finishes about 3 s into the renewal's stage; the success comes 6 s in - after the stage's own
        // deadline, though within 5 s of the close.
        await sleep(Math.max(0, 3000 - (Date.now() - began)));
        held.release();
        x.answer = await held.archive;
        await sleep(Math.max(0, 6000 - (Date.now() - began)));
        assertOpenOrUnconfirmed(h.s.op(held.id).download.attempts[0], name);
        r.open();
      } else if (name === 'an error while the result row is written') {
        held.release();
        x.answer = await held.archive;
        assert.ok(await within(closing.held, 9000), name + ': the result row is being written');
        r.open();
        for (let i = 0; i < 100 && !r.answered(); i++) await sleep(10);
        await sleep(50);
        closing.open();
      } else if (name === 'an error within its deadline during the result write') {
        held.release();
        x.answer = await held.archive;
        await sleep(300);
        r.open();
        assert.ok(await within(closing.held, 9000), name + ': the result row is being written');
        closing.open();
      } else {
        held.release();
        x.answer = await held.archive;
        x.closedFirst = await closed(h, held.id);
        // A new attempt while the old renewal's answer is still out; that answer then arrives (an error) meanwhile.
        process.env.ORTHANC_URL = 'http://127.0.0.1:' + h.orthanc.server.address().port;
        const retry = h.request('GET', archivePath(held.study, held.id), { as: RAD });
        await sleep(20);
        r.open();
        x.retry = await retry;
      }
    }));
  } finally { for (const x of runs) { x.r.open(); x.closing?.open(); x.held.release(); } }
  for (const { name, h, held, closing, answer, retry, closedFirst } of runs) {
    const a = await closed(h, held.id);
    h.s.onQuery = null; h.s.onCommitted = null; closing?.restore();
    assert.deepEqual([a.state, a.archiveSha256, a.responseFinished, resultRows(h, a.attemptId).length], ['unconfirmed', null, false, 1], name);
    assert.equal(answer.complete, true, name + ': the writer had finished');
    const [row] = resultRows(h, a.attemptId);
    assert.deepEqual([row.detail.state, row.detail.archiveSha256, row.detail.responseFinished], ['unconfirmed', null, false], name + ': the result row says the same');
    if (retry) {
      assert.equal(retry.bytes.length, Number(retry.headers['content-length']), name + ': the new attempt sends the whole archive');
      await closed(h, held.id, 1);
      const attempts = h.s.op(held.id).download.attempts;
      assert.deepEqual(attempts.map(x => x.state), ['unconfirmed', 'sent']);
      assert.deepEqual(attempts[0], closedFirst, name + ': the old attempt unchanged by its late answer');
      assert.deepEqual([intents(h, attempts[1].attemptId).length, resultRows(h, attempts[1].attemptId).length], [1, 1]);
    }
  }
}

test('S9U4-B64 probe-renewal-error-during-terminal-write (U4BB4-04): the renewal\'s error comes back within its deadline after the writer finished - the result row and the attempt are Unconfirmed, not Sent; the answer held past the deadline, the attempt is closed Unconfirmed and an error arriving while that result row is being written changes nothing - one result row, no archive hash, response not finished', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  await outstandingSideBySide(t, ['an error within its deadline during the result write', 'an error while the result row is written']);
});

test('S9U4-B65 the close waits for an outstanding approval only within that approval\'s own deadline (U4BB4-04): a success after it (still within a fresh 5 s from the close) changes nothing, nor does an old answer during a new attempt; now == deadline at the consumption is expired; a stage consumed in time is not expired again by the close\'s own database wait; the close takes no lock while it waits; an attempt fenced meanwhile is left as it was', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  await outstandingSideBySide(t, ['a success after its deadline', 'an old error during a new attempt']);
  // now == deadline at the consumption: the monotonic clock held still from before the renewal; both writers finish on
  // it; then the outstanding success is consumed at start + 4999 ms (in time: Sent) and at start + 5000 ms (expired).
  {
    const pair = [];
    for (const offset of [STAGE_MS - 1, STAGE_MS]) {
      const h = await harness();
      const held = await heldArchive(h);
      pair.push({ offset, h, held, r: heldAnswer(h) });
    }
    const real = performance.now.bind(performance);
    let frozen = null;
    const clock = t.mock.method(performance, 'now', () => frozen ?? real());
    const start = frozen = real();
    try {
      t.mock.timers.tick(10000);
      for (const x of pair) assert.ok(await within(x.r.held, 3000));
      for (const x of pair) { x.held.release(); x.answer = await x.held.archive; }
      for (const x of pair) {
        frozen = start + x.offset;
        x.r.open();
        x.a = await closed(x.h, x.held.id, 0, 3000);
      }
    } finally { clock.mock.restore(); for (const x of pair) { x.r.open(); x.held.release(); x.h.s.onQuery = null; x.h.s.onCommitted = null; } }
    const [inTime, atDeadline] = pair;
    assert.deepEqual([inTime.a.state, inTime.a.responseFinished], ['sent', true], 'consumed at start + 4999 ms: in time');
    assert.deepEqual([atDeadline.a.state, atDeadline.a.archiveSha256, atDeadline.a.responseFinished], ['unconfirmed', null, false], 'consumed at start + 5000 ms: expired');
  }
  // A stage answered and consumed in time is not expired again by the close's own database wait: the renewal answers at
  // once; then the close's row read takes 6 s on the monotonic clock (past that renewal's old deadline) - Sent.
  {
    const h = await harness();
    const held = await heldArchive(h);
    const sub = submitted(held.study, held.id);
    const lease = h.s.op(held.id).download.attempts[0].leaseUntil;
    h.s.advance(1000);
    const real = performance.now.bind(performance);
    let shift = 0;
    const clock = t.mock.method(performance, 'now', () => real() + shift);
    h.s.onQuery = async (sql, _values, tx) => { if (sub.ended && tx && sql.includes('WHERE id = ?::uuid FOR UPDATE')) shift = 6000; };
    let answer;
    try {
      t.mock.timers.tick(10000);
      for (let i = 0; i < 100 && h.s.op(held.id).download.attempts[0].leaseUntil === lease; i++) await sleep(10);
      assert.notEqual(h.s.op(held.id).download.attempts[0].leaseUntil, lease, 'the renewal committed');
      await sleep(50);
      held.release();
      answer = await held.archive;
      await closed(h, held.id);
    } finally { clock.mock.restore(); h.s.onQuery = null; held.release(); }
    assert.equal(shift, 6000, 'the close\'s database wait passed the renewal\'s old deadline');
    const [a] = h.s.op(held.id).download.attempts;
    assert.deepEqual([a.state, a.responseFinished, a.archiveSha256], ['sent', true, createHash('sha256').update(answer.bytes).digest('hex')]);
  }
  // No lock while the close waits. (i) Only the answer outstanding (the renewal's locks released): an independent
  // transaction on the operation row - the status GET's expiry pass - goes through meanwhile; then the success: Sent.
  // (ii) The renewal's commit itself held (its locks still taken), started by the writer's last write: that transaction
  // waits for the renewal, not for the close; once the commit answers, both go through - Sent, one result row.
  {
    const h = await harness();
    const held = await heldArchive(h);
    const r = heldAnswer(h);
    let get;
    try {
      t.mock.timers.tick(10000);
      assert.ok(await within(r.held, 3000));
      held.release();
      await held.archive;
      get = h.request('GET', statusPath(held.study, held.id), { as: RAD });
      assert.ok(await within(get, 2000), '(i) the operation row is not held while the answer is outstanding');
      assert.equal(r.answered(), false);
      const viewed = await get;
      assert.equal(viewed.status, 200);
      assertOpenOrUnconfirmed(viewed.body.attempts[0], '(i)');
      r.open();
    } finally { r.open(); held.release(); h.s.onQuery = null; }
    const a = await closed(h, held.id);
    h.s.onCommitted = null;
    assert.deepEqual([a.state, a.responseFinished, resultRows(h, a.attemptId).length], ['sent', true, 1], '(i)');
  }
  {
    const h = await harness();
    const held = await heldArchive(h);
    const sub = submitted(held.study, held.id);
    const commit = barrier();
    let ticked = false, armed = false;
    sub.onWrite = w => { if (!ticked && w.chunks[w.chunks.length - 1].includes(END_SIG)) { ticked = true; armed = true; t.mock.timers.tick(10000); } };
    h.s.onQuery = async (sql, _values, tx) => { if (armed && tx && casSql(sql)) { armed = false; tx.watched = true; } };
    h.s.onCommit = async tx => { if (tx.watched) await commit.park(); };
    let get, answer;
    try {
      held.release();
      assert.ok(await within(commit.held, 5000), '(ii) the renewal started at the last write; its commit is held with its locks');
      answer = await held.archive;
      get = h.request('GET', statusPath(held.study, held.id), { as: RAD });
      assert.equal(await within(get, 300), false, '(ii) the row is the renewal\'s until its commit');
      assert.equal(h.s.op(held.id).download.attempts[0].state, 'sending');
      commit.open();
      assert.ok(await within(get, 3000), '(ii) the independent transaction goes through after the commit');
    } finally { commit.open(); held.release(); h.s.onQuery = null; h.s.onCommit = null; }
    const a = await closed(h, held.id);
    assert.equal((await get).status, 200);
    assert.deepEqual([a.state, a.responseFinished, a.archiveSha256, resultRows(h, a.attemptId).length],
      ['sent', true, createHash('sha256').update(answer.bytes).digest('hex'), 1], '(ii)');
  }
  // An attempt fenced while the renewal's answer is out (DB time past the lease, the status GET closes it) is left as it
  // was by this close: its one lease-expired result row; the later success revives nothing.
  {
    const h = await harness();
    const held = await heldArchive(h);
    const sub = submitted(held.study, held.id);
    const r = heldAnswer(h);
    try {
      t.mock.timers.tick(10000);
      assert.ok(await within(r.held, 3000));
      h.s.advance(31000);
      const fence = await h.request('GET', statusPath(held.study, held.id), { as: RAD });
      assert.equal(fence.body.attempts[0].state, 'unconfirmed');
      const mark = { calls: sub.calls };
      held.release();
      await held.archive;
      r.open();
      for (let i = 0; i < 100 && !r.answered(); i++) await sleep(10);
      await sleep(100);
      assert.equal(sub.calls, mark.calls, 'nothing supplied after the fence');
    } finally { r.open(); held.release(); h.s.onQuery = null; h.s.onCommitted = null; }
    const [a] = h.s.op(held.id).download.attempts;
    assert.deepEqual([a.state, resultRows(h, a.attemptId).map(x => [x.detail.state, x.detail.reason])], ['unconfirmed', [['unconfirmed', 'lease-expired']]]);
  }
});

test('S9U4-B66 probe-stage1-next-work (U4BB4-03): a credential answer past stage 1\'s deadline starts no StudyAccess metadata read - Incomplete, nothing supplied, one result row; on the monotonic clock held still the answer at start + 5000 ms reads nothing and at start + 4999 ms the metadata read follows and the whole archive is Sent', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  // The credential check of object 2's first payload approval answers (valid) 5200 ms late with the event loop held.
  {
    const h = await harness();
    const p = await atFirstPayload(h);
    let expired = false, reads = 0;
    h.s.onAuth = async () => { if (p.armed) { p.take(); stall(5200); expired = true; } };
    h.s.onQuery = async (sql, _values, tx) => { if (expired && !tx && policyRead(sql)) reads++; };
    try { p.held.release(); await p.held.archive; } finally { h.s.onAuth = null; h.s.onQuery = null; p.held.release(); }
    assertRightsStop(await assertNoSupplyAfter(h, p.held, p.sub, p.mark, p.at), p.checkpoint);
    assert.equal(reads, 0, 'no metadata read starts after the credential stage ran past its deadline');
  }
  // The same on the monotonic clock held still: the credential answering at start + 4999 ms goes on to the metadata
  // read and the whole archive; at start + 5000 ms nothing is read.
  for (const offset of [STAGE_MS - 1, STAGE_MS]) {
    const h = await harness();
    const p = await atFirstPayload(h);
    const real = performance.now.bind(performance);
    let frozen = null, start = null, answered = false, reads = 0;
    const clock = t.mock.method(performance, 'now', () => frozen ?? real());
    p.onHeader = () => { frozen = start = real(); };
    h.s.onAuth = async () => { if (p.armed) { p.take(); frozen = start + offset; answered = true; } };
    h.s.onQuery = async (sql, _values, tx) => { if (answered && !tx && policyRead(sql)) reads++; };
    let answer;
    try { p.held.release(); answer = await p.held.archive; } finally { clock.mock.restore(); h.s.onAuth = null; h.s.onQuery = null; p.held.release(); }
    if (offset === STAGE_MS) {
      assertRightsStop(await assertNoSupplyAfter(h, p.held, p.sub, p.mark, p.at), p.checkpoint);
      assert.equal(reads, 0, 'expired at the deadline: no metadata read');
    } else {
      assert.ok(reads >= 1, 'in time: the metadata read follows');
      await assertWhole(h, p.held, answer);
    }
  }
});

test('S9U4-B67 probe-sync-supply-return (U4BB4-03): a synchronous supply that ran to stage 2\'s deadline is checked before its transaction returns - the renewal in it rolls back (the lease as it was), Unconfirmed with the checkpoint, no archive hash, response not finished, one result row; the chunk already handed to the response went out once and nothing after it', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  // Object 2's first payload approval renews the lease (DB time 15 s on); its synchronous supply runs to the stage's
  // deadline on the monotonic clock: the expiry is found before the transaction answers - its renewal rolls back.
  {
    const h = await harness();
    const p = await atFirstPayload(h);
    let stalled = false;
    const oldLease = h.s.op(p.held.id).download.attempts[0].leaseUntil;
    const real = performance.now.bind(performance);
    let frozen = null, start = null;
    const clock = t.mock.method(performance, 'now', () => frozen ?? real());
    p.sub.onWrite = r => {
      if (r.bytes === p.at[1].payload) { p.armed = true; Object.assign(p.mark, { W0: p.sub.calls, B0: p.sub.bytes }); h.s.advance(15000); frozen = start = real(); }
      else if (p.armed && r.bytes > p.at[1].payload) { p.armed = false; frozen = start + STAGE_MS; stalled = true; }
    };
    let answer;
    try { p.held.release(); answer = await p.held.archive; } finally { clock.mock.restore(); p.held.release(); }
    const a = await closed(h, p.held.id);
    assert.equal(stalled, true);
    assertOneChunk(p, answer, 'synchronous supply past the deadline');
    assertApprovalStop(a, p.checkpoint);
    assert.deepEqual([a.archiveSha256, a.responseFinished, resultRows(h, a.attemptId).length], [null, false, 1]);
    assert.equal(a.leaseUntil, oldLease, 'the expiry found before the callback returned rolled its renewal back');
  }
});

test('S9U4-B68 the time between a completion\'s own check and the consumption of its result belongs to the stage (U4BB4-05): when the monotonic clock reaches the deadline right after a stage\'s completion was first judged in time, the result is still not taken - a valid stage-1 answer stops Incomplete with nothing supplied, a stage-2 refusal and a stage-2 commit success are expired approvals (Unconfirmed, the checkpoint as it was, nothing more than the chunk already handed over)', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  for (const mode of ['stage 1 valid answer', 'stage 2 refusal', 'stage 2 commit success']) {
    const h = await harness();
    const p = await atFirstPayload(h);
    const real = performance.now.bind(performance);
    let frozen = null, start = null, next = false, moved = false;
    // The clock is held still from object 2's local header on; armed at the completion, it reaches the stage's
    // deadline right after the next reading - the completion's own check, made in time.
    const clock = t.mock.method(performance, 'now', () => {
      const now = frozen ?? real();
      if (next) { next = false; moved = true; frozen = start + STAGE_MS; }
      return now;
    });
    p.onHeader = () => { frozen = start = real(); Object.assign(p.mark, { W0: p.sub.calls, B0: p.sub.bytes }); };
    if (mode === 'stage 1 valid answer') h.s.onQuery = async (sql, _values, tx) => { if (p.armed && !tx && policyRead(sql)) { p.armed = false; next = true; } };
    else {
      h.s.onQuery = async (sql, _values, tx) => {
        if (p.armed && tx && casSql(sql)) { p.armed = false; tx.watched = true; }
        else if (mode === 'stage 2 refusal' && tx?.watched && policyRead(sql)) h.s.policies.set(RAD.sub, deniedPolicy);
      };
      h.s.onCommitted = async tx => { if (tx.watched) next = true; };
    }
    let answer;
    try { p.held.release(); answer = await p.held.archive; } finally { clock.mock.restore(); h.s.onQuery = null; h.s.onCommitted = null; p.held.release(); }
    const a = await closed(h, p.held.id);
    assert.equal(moved, true, mode + ': the clock reached the deadline after the completion\'s check');
    assert.deepEqual([a.archiveSha256, a.responseFinished, resultRows(h, a.attemptId).length], [null, false, 1], mode);
    if (mode === 'stage 2 commit success') { assertOneChunk(p, answer, mode); assertApprovalStop(a, p.checkpoint); continue; }
    assert.deepEqual([p.sub.calls - p.mark.W0, p.sub.bytes - p.mark.B0, p.sub.ended, answer.complete], [0, 0, false, false], mode + ': nothing after the local header');
    if (mode === 'stage 1 valid answer') assertRightsStop(a, p.checkpoint); else assertApprovalStop(a, p.checkpoint);
  }
});

// ════════════════════════════════ round 6: what PostgreSQL gives back (U4BL-01, U4BL-02, the store's fidelity) ════════════════════════════════
// The first live batch on ee8b707 failed where this file's store had answered as PostgreSQL does not: a recovery record
// read back from the JSONB column results in another key order (outcomes: 409 after the re-read) and a literal null on
// the JSONB claim of a new download stored as the JSON null value (routes: 23514, 503 on prepare). B69 keeps the store's
// side; B70-B72 are those two failures as server cases (red on ee8b707, green on round 6 - REQ/RISK-S9-U4-05/06/08/13).

// The recovery record as PostgreSQL 16 gave it back (the round 6 live diagnosis: a throwaway postgres:16-alpine with the
// ImportOperation migration and the API image's Prisma 5.22 client): written in the first order, read in the second.
const RECOVERY_WRITTEN = ['basis', 'checkedAt', 'adminIssuer', 'adminSubject', 'adminActor', 'requestedAt', 'resolvedAt'];
const RECOVERY_READ = ['basis', 'checkedAt', 'adminActor', 'resolvedAt', 'adminIssuer', 'requestedAt', 'adminSubject'];
const until = async (condition, what) => { for (let i = 0; i < 500 && !condition(); i++) await sleep(10); assert.ok(condition(), what); };

test('S9U4-B69 R6-N04 the store keeps the two JSONB nulls apart and reads JSONB back in jsonb order: omitted and Prisma.DbNull are SQL NULL; a literal null and Prisma.JsonNull are the JSON null value, refused 23514 wherever a kind requires SQL NULL or an object, on create and on update with the row and the audit rows unchanged; nested nulls stay JSON values; object keys come back in the PostgreSQL sample\'s order, arrays in theirs, as a new value', async () => {
  const s = store();
  const tx = fn => s.prisma.$transaction(fn, { isolationLevel: 'ReadCommitted', maxWait: 4000, timeout: 8000 });
  const at = new Date(T0).toISOString();
  const member = { institutionId: 'inst-a', ownerIssuer: ISSUER, ownerSubject: TECH.sub, actor: TECH.actor };
  const gate = { institutionId: 'inst-a', ownerIssuer: 'kin-internal', ownerSubject: 'dicom-import-gate', actor: 'dicom-import-gate', status: 'reserved', results: [] };
  const recovery = Object.fromEntries(RECOVERY_WRITTEN.map(k => [k, k === 'basis' ? 'orthanc-restarted' : k.startsWith('admin') ? 'synthetic-admin' : k === 'resolvedAt' ? null : at]));
  const make = {
    import: () => { const study = uid(); return { id: randomUUID(), ...member, kind: 'import', status: 'open', results: [{ index: 0, studyUid: study, outcome: 'unconfirmed',
      code: 'IMPORT_UNCONFIRMED', writeDisposition: null, attempts: [{ attemptId: randomUUID(), generation: 1, phase: 'unknown', recovery }] }] }; },
    download: () => ({ id: randomUUID(), ...member, kind: 'download', studyUid: uid(), status: 'prepared', manifestSha256: 'a'.repeat(64),
      download: { schemaVersion: 1, attempts: [], 'é': 1, ab: 2, b: 3, 10: 'ten', 2: 'two' } }),
    'study-claim': () => { const study = uid(); return { id: randomUUID(), ...gate, kind: 'study-claim', studyUid: study, claimKey: 'study:' + study,
      claim: { schemaVersion: 1, phase: 'bound', patientId: null, heldByAttemptId: null } }; },
    'sop-claim': () => { const study = uid(); return { id: randomUUID(), ...gate, kind: 'sop-claim', studyUid: study, claimKey: 'sop:' + study + '.1.1',
      claim: { schemaVersion: 1, patientId: 'SYN-S', sha256: null, heldByAttemptId: null } }; },
  };
  // migration.sql ImportOperation_kind_check: the JSONB columns each kind requires SQL NULL, and those it requires an object.
  const requiredNull = { import: ['download', 'claim'], download: ['claim'], 'study-claim': ['download'], 'sop-claim': ['download'] };
  const requiredObject = { import: [], download: ['download'], 'study-claim': ['claim'], 'sop-claim': ['claim'] };
  const JSON_NULLS = [['a literal null', null], ['Prisma.JsonNull', Prisma.JsonNull]];
  const refusedCreate = async (data, name) => {
    const size = s.ops.size, audited = s.audits.length;
    await assert.rejects(tx(db => db.importOperation.create({ data })), error => error.meta?.code === '23514', name);
    assert.deepEqual([s.ops.size, s.audits.length, s.ops.has(data.id)], [size, audited, false], name + ': nothing inserted');
  };
  const refusedUpdate = async (id, data, name) => {
    const before = s.op(id), kinds = ['results', 'download', 'claim'].map(c => s.nullKind(id, c)), audited = s.audits.length;
    // The audit row in the same transaction rolls back with the refused update.
    await assert.rejects(tx(async db => { await db.auditLog.create({ data: { actor: 'synthetic', action: 'synthetic.probe', target: id, detail: '{}' } });
      return db.importOperation.update({ where: { id }, data }); }), error => error.meta?.code === '23514', name);
    assert.deepEqual([s.op(id), ['results', 'download', 'claim'].map(c => s.nullKind(id, c)), s.audits.length], [before, kinds, audited], name + ': rolled back');
  };
  const rows = {};
  for (const kind of Object.keys(make)) {
    // Omitted, and Prisma.DbNull: SQL NULL, accepted on create; DbNull on update keeps it SQL NULL.
    const omitted = make[kind]();
    await tx(db => db.importOperation.create({ data: omitted }));
    const explicit = make[kind]();
    await tx(db => db.importOperation.create({ data: { ...explicit, ...Object.fromEntries(requiredNull[kind].map(c => [c, Prisma.DbNull])) } }));
    for (const id of [omitted.id, explicit.id]) for (const column of requiredNull[kind]) assert.equal(s.nullKind(id, column), 'SQL NULL', `${kind} ${column}`);
    await tx(db => db.importOperation.update({ where: { id: omitted.id }, data: Object.fromEntries(requiredNull[kind].map(c => [c, Prisma.DbNull])) }));
    for (const column of requiredNull[kind]) assert.equal(s.nullKind(omitted.id, column), 'SQL NULL', `${kind} ${column}: DbNull on update`);
    rows[kind] = omitted.id;
    // A JSON null where the kind requires SQL NULL: refused on create and on update.
    for (const column of requiredNull[kind]) for (const [name, value] of JSON_NULLS) {
      await refusedCreate({ ...make[kind](), [column]: value }, `${kind}: ${column} ${name} on create`);
      await refusedUpdate(omitted.id, { [column]: value }, `${kind}: ${column} ${name} on update`);
    }
    // A JSON null or SQL NULL where the kind requires an object: refused on create and on update.
    for (const column of requiredObject[kind]) for (const [name, value] of [...JSON_NULLS, ['Prisma.DbNull', Prisma.DbNull]]) {
      await refusedCreate({ ...make[kind](), [column]: value }, `${kind}: ${column} ${name} on create`);
      await refusedUpdate(omitted.id, { [column]: value }, `${kind}: ${column} ${name} on update`);
    }
    // results is NOT NULL: the JSON null value is no array (23514); SQL NULL is a not-null violation (23502), not a check one.
    await refusedUpdate(omitted.id, { results: Prisma.JsonNull }, `${kind}: results Prisma.JsonNull`);
    await assert.rejects(tx(db => db.importOperation.update({ where: { id: omitted.id }, data: { results: Prisma.DbNull } })), error => error.meta?.code === '23502', `${kind}: results SQL NULL`);
    // An omitted (undefined) field changes nothing.
    const before = s.op(omitted.id);
    await tx(db => db.importOperation.update({ where: { id: omitted.id }, data: { download: undefined, claim: undefined } }));
    assert.deepEqual({ ...s.op(omitted.id), updatedAt: before.updatedAt }, before, `${kind}: undefined is no change`);
  }
  // The U4BL-02 write itself: a download with claimKey and claim given as literal nulls - the JSON null claim is refused.
  await refusedCreate({ ...make.download(), claimKey: null, claim: null }, 'download: claimKey null, claim null (ee8b707 prepare)');
  // Nested nulls are JSON values: kept inside their object, the column itself an object.
  assert.deepEqual([s.nullKind(rows['study-claim'], 'claim'), s.op(rows['study-claim']).claim.patientId, s.op(rows['sop-claim']).claim.sha256], ['object', null, null]);
  // Any number of rows with a SQL NULL claimKey; the second row of an existing key is a unique violation (P2002), not 23514.
  await assert.rejects(tx(db => db.importOperation.create({ data: { ...make['study-claim'](), studyUid: s.op(rows['study-claim']).studyUid,
    claimKey: s.op(rows['study-claim']).claimKey } })), error => error.code === 'P2002');
  // Readback: object keys in jsonb order (shorter UTF-8 byte length first, then bytewise) at every depth - the recovery
  // record exactly as the PostgreSQL sample - arrays in their own order; each read a new value; the same on a FOR UPDATE.
  const imported = await s.prisma.importOperation.findUnique({ where: { id: rows.import } });
  assert.deepEqual(Object.keys(s.ops.get(rows.import).results[0].attempts[0].recovery), RECOVERY_WRITTEN, 'stored as written');
  assert.deepEqual(Object.keys(imported.results[0].attempts[0].recovery), RECOVERY_READ, 'read back in the sample\'s order');
  assert.deepEqual(Object.keys(imported.results[0]), ['code', 'index', 'outcome', 'attempts', 'studyUid', 'writeDisposition']);
  assert.deepEqual(Object.keys(imported.results[0].attempts[0]), ['phase', 'recovery', 'attemptId', 'generation']);
  const [locked] = await tx(db => db.$queryRaw(['SELECT * FROM "ImportOperation" WHERE id = ', '::uuid FOR UPDATE'], rows.import));
  assert.deepEqual(Object.keys(locked.results[0].attempts[0].recovery), RECOVERY_READ, 'the same on a locked read');
  const downloaded = await s.prisma.importOperation.findUnique({ where: { id: rows.download } });
  // 'b' (1 byte) < 'ab' (2) < 'é' (2 bytes, 0xC3 after 0x61); JS lists integer-like keys first, as after JSON.parse.
  assert.deepEqual(Object.keys(downloaded.download), ['2', '10', 'b', 'ab', 'é', 'attempts', 'schemaVersion']);
  assert.deepEqual(Object.keys((await s.prisma.importOperation.findUnique({ where: { id: rows['study-claim'] } })).claim), ['phase', 'patientId', 'schemaVersion', 'heldByAttemptId']);
  imported.results[0].attempts[0].recovery.basis = 'changed by the reader';
  assert.equal(s.ops.get(rows.import).results[0].attempts[0].recovery.basis, 'orthanc-restarted', 'a read is a new value, never the stored one');
  assert.deepEqual([downloaded.createdAt instanceof Date, typeof s.op(rows.download).createdAt], [true, 'string']);
});

test('S9U4-B70 R6-N03 a download prepare where SQL NULL and JSON null differ (U4BL-02): 200 prepared with claimKey and claim SQL NULL and the fixed manifest under its hash, one prepare row; the same id replays the same view with no second row (also two at once); status and archive answer; claim stays SQL NULL through Sent', async () => {
  const h = await harness();
  const study = await downloadStudy(h, 2), id = randomUUID();
  const first = await prepare(h, study, id);
  assert.deepEqual([first.status, first.body?.state, first.body?.code ?? null], [200, 'prepared', null], JSON.stringify(first.body));
  const op = h.s.op(id);
  assert.deepEqual([op.kind, op.status, op.studyUid, op.claimKey, h.s.nullKind(id, 'claimKey'), h.s.nullKind(id, 'claim'), h.s.nullKind(id, 'download')],
    ['download', 'prepared', study, null, 'SQL NULL', 'SQL NULL', 'object']);
  assert.equal(sha(Buffer.from(op.download.manifestCanonical, 'utf8')), op.manifestSha256, 'the stored manifest under its hash');
  assert.deepEqual([first.body.operationId, first.body.studyUid, first.body.manifestSha256, first.body.preparedAt, first.body.objects, first.body.attempts],
    [id, study, op.manifestSha256, op.download.preparedAt, 2, []], 'the answer is the stored row\'s');
  assert.equal(audits(h.s, 'original.download.prepare').length, 1);
  const replay = await prepare(h, study, id);
  assert.deepEqual([replay.status, replay.body, audits(h.s, 'original.download.prepare').length], [200, first.body, 1], 'the same id replays the same view, no second row');
  const twin = randomUUID();
  const both = await Promise.all([prepare(h, study, twin), prepare(h, study, twin)]);
  assert.deepEqual([both.map(r => r.status), both[0].body, [...h.s.ops.values()].filter(r => r.id === twin).length, audits(h.s, 'original.download.prepare').length],
    [[200, 200], both[1].body, 1, 2], 'two prepares of one new id: one row, one prepare row, the same view');
  const status = await h.request('GET', `/api/studies/${study}/original-downloads/${id}`, { as: RAD });
  assert.deepEqual([status.status, status.body.state, status.body.manifestSha256], [200, 'prepared', op.manifestSha256]);
  const zip = await h.request('GET', archivePath(study, id), { as: RAD });
  assert.equal(zip.status, 200);
  await sleep(50);
  assert.deepEqual([h.s.op(id).status, h.s.nullKind(id, 'claim'), h.s.nullKind(id, 'claimKey')], ['sent', 'SQL NULL', 'SQL NULL'], 'Sent; claim still SQL NULL');
});

test('S9U4-B71 R6-N01 the admin recovery of an expired unknown attempt whose record reads back from JSONB in jsonb order (U4BL-01): 200 retryable RECOVERED_NO_OBJECT with resolvedAt, the request and result rows of its admin, the holders released, no Orthanc write, and the owner\'s resend stores once as generation 2; a request left unresolved with its reading right (as ee8b707 left them) is not taken over while that right lives and completes after it ran out, its first request row kept', async () => {
  const h = await harness();
  const a = await unknownAttempt(h);
  h.s.advance(31000);
  const postsBefore = posts(h.orthanc);
  const r = await recovery(h, a.id, { basis: 'orthanc-restarted', checkedAt: a.attempt.startedAt });
  // The live run's precondition: the record written in step 1 reads back in another key order.
  assert.deepEqual(Object.keys(h.s.file(a.id, 0).attempts.at(-1).recovery), RECOVERY_READ, 'the stored record reads back in jsonb key order');
  assert.deepEqual([r.status, r.body.outcome, r.body.code], [200, 'retryable', 'RECOVERED_NO_OBJECT'], JSON.stringify(r.body));
  const now = new Date(h.s.clock).toISOString(), file = h.s.file(a.id, 0), mine = file.attempts.at(-1);
  assert.deepEqual([file.outcome, file.code, mine.recovery.resolvedAt, mine.recovery.requestedAt, mine.recovery.adminSubject, mine.recovery.adminActor, mine.recovery.basis],
    ['retryable', 'RECOVERED_NO_OBJECT', now, now, ADMIN.sub, ADMIN.actor, 'orthanc-restarted']);
  const [request] = audits(h.s, 'dicom.import.recovery.request'), results = audits(h.s, 'dicom.import.recovery.result');
  assert.deepEqual([request.actor, request.detail.attemptId, results.length, results[0].actor, results[0].detail.attemptId, results[0].detail.code],
    [ADMIN.actor, a.attempt.attemptId, 1, ADMIN.actor, a.attempt.attemptId, 'RECOVERED_NO_OBJECT']);
  assert.deepEqual([h.s.claim('study:' + a.study).claim.heldByAttemptId, h.s.claim('sop:' + file.sopUid).claim.heldByAttemptId], [null, null], 'holders released');
  assert.deepEqual([posts(h.orthanc), h.orthanc.count()], [postsBefore, 0], 'the recovery writes no original');
  const resent = await h.send(a.bytes, { id: a.id });
  assert.deepEqual([resent.status, resent.body.outcome, resent.body.generation, h.orthanc.count()], [200, 'stored', 2, 1]);
  // What a failed request leaves (its request row, the record unresolved, an unknown attempt's reading right, the holders):
  // made here by the product itself - the study left the admin's reach during the re-read (as in S9U4-B54).
  const h2 = await harness();
  const b = await unknownAttempt(h2);
  h2.s.advance(31000);
  let restore = null;
  h2.orthanc.fault = call => { if (call.path === '/tools/lookup' && !restore) restore = OUT_OF_REACH.moved(h2, { study: b.study }); return null; };
  const lost = await recovery(h2, b.id, { basis: 'orthanc-log-checked', checkedAt: b.attempt.startedAt });
  h2.orthanc.fault = null;
  restore();
  const left = h2.s.file(b.id, 0).attempts.at(-1);
  assert.deepEqual([lost.status, left.recovery.resolvedAt, Date.parse(left.leaseUntil) > h2.s.clock, h2.s.claim('study:' + b.study).claim.heldByAttemptId],
    [404, null, true, b.attempt.attemptId], 'an unresolved request with its reading right and holders');
  const early = await recovery(h2, b.id, { basis: 'orthanc-restarted', checkedAt: b.attempt.startedAt }, ADMIN2);
  assert.deepEqual([early.status, early.body.code, audits(h2.s, 'dicom.import.recovery.request').length, h2.s.file(b.id, 0).attempts.at(-1).recovery.adminSubject],
    [409, 'RECOVERY_NOT_APPLICABLE', 1, ADMIN.sub], 'its live reading right is not taken over');
  h2.s.advance(31000);
  const done = await recovery(h2, b.id, { basis: 'orthanc-restarted', checkedAt: b.attempt.startedAt }, ADMIN2);
  assert.deepEqual([done.status, done.body.code], [200, 'RECOVERED_NO_OBJECT'], JSON.stringify(done.body));
  assert.deepEqual([audits(h2.s, 'dicom.import.recovery.request').map(x => x.actor), audits(h2.s, 'dicom.import.recovery.result').map(x => x.actor)],
    [[ADMIN.actor, ADMIN2.actor], [ADMIN2.actor]], 'the first request row kept, the new request and its result added');
  assert.deepEqual([h2.s.claim('study:' + b.study).claim.heldByAttemptId, posts(h2.orthanc)], [null, 0]);
});

test('S9U4-B72 R6-N02 the admin recovery of a may-have-written occupancy over a JSONB readback (U4BL-01): released with its result unchanged and both rows; left unresolved it is recovered again at once; two requests within one DB millisecond with the same checkedAt but another admin and basis - the earlier, answered first, is 409 with no result row and the later 200; an exact object is Stored; a failed Orthanc read is 503 with only the reading right given back, so the next request reads at once', async () => {
  // A may-have-written occupancy: released; outcome, code and disposition as they were; request and result rows.
  {
    const h = await harness();
    const t = await mayHaveWritten(h);
    const before = h.s.file(t.id, 1), objects = h.orthanc.count(), postsBefore = posts(h.orthanc);
    const r = await recovery(h, t.id, evidenceFor(h, t), ADMIN, 1);
    assert.deepEqual([r.status, r.body.outcome, r.body.code, r.body.writeDisposition], [200, 'rejected', 'SOP_UID_AMBIGUOUS', 'may-have-written'], JSON.stringify(r.body));
    const after = h.s.file(t.id, 1);
    assert.deepEqual([after.outcome, after.code, after.writeDisposition, after.attempts.length], [before.outcome, before.code, before.writeDisposition, before.attempts.length]);
    assert.deepEqual([after.attempts.at(-1).recovery.resolvedAt, h.s.claim('study:' + t.study).claim.heldByAttemptId, h.s.claim('sop:' + after.sopUid).claim.heldByAttemptId],
      [new Date(h.s.clock).toISOString(), null, null]);
    assert.deepEqual([audits(h.s, 'dicom.import.recovery.request').length, audits(h.s, 'dicom.import.recovery.result').length, h.orthanc.count(), posts(h.orthanc)],
      [1, 1, objects, postsBefore], 'both rows; Orthanc untouched');
  }
  // Left unresolved by a request that lost the study's reach during its re-read: no reading right to wait for - the next
  // request recovers it at once and the first request row stays.
  {
    const h = await harness();
    const t = await mayHaveWritten(h);
    let restore = null;
    h.orthanc.fault = call => { if (call.path === '/tools/lookup' && !restore) restore = OUT_OF_REACH.moved(h, t); return null; };
    const lost = await recovery(h, t.id, evidenceFor(h, t), ADMIN, 1);
    h.orthanc.fault = null;
    restore();
    assert.deepEqual([lost.status, h.s.file(t.id, 1).attempts.at(-1).recovery.resolvedAt], [404, null]);
    const again = await recovery(h, t.id, evidenceFor(h, t), ADMIN2, 1);
    assert.deepEqual([again.status, again.body.outcome], [200, 'rejected'], JSON.stringify(again.body));
    assert.deepEqual([audits(h.s, 'dicom.import.recovery.request').map(x => x.actor), audits(h.s, 'dicom.import.recovery.result').map(x => x.actor)],
      [[ADMIN.actor, ADMIN2.actor], [ADMIN2.actor]]);
  }
  // Two admins within one DB millisecond, the same checkedAt, another admin and basis. The later request record replaces
  // the earlier one; the earlier request's re-read is answered first and finds the record changed: 409, no result row;
  // the later one then commits. Only the admin, the basis (and the request time) tell the two records apart here.
  {
    const h = await harness();
    const t = await mayHaveWritten(h);
    const checkedAt = evidenceFor(h, t).checkedAt, clock = h.s.clock;
    const reads = [];
    h.orthanc.fault = async call => {
      if (call.path !== '/tools/lookup') return null;
      const read = {}; read.held = new Promise(resolve => { read.release = resolve; }); reads.push(read);
      await read.held;
      return null;
    };
    let first, second;
    try {
      first = recovery(h, t.id, { basis: 'orthanc-log-checked', checkedAt }, ADMIN, 1);
      await until(() => reads.length === 1, 'the first request reads');
      second = recovery(h, t.id, { basis: 'orthanc-restarted', checkedAt }, ADMIN2, 1);
      await until(() => reads.length === 2, 'the second request reads');
      reads[0].release();
      first = await first;
      reads[1].release();
      second = await second;
    } finally { for (const read of reads) read.release(); h.orthanc.fault = null; }
    assert.equal(h.s.clock, clock, 'one DB millisecond');
    assert.deepEqual([[first.status, first.body.code], [second.status, second.body.outcome]], [[409, 'RECOVERY_NOT_APPLICABLE'], [200, 'rejected']]);
    const requests = audits(h.s, 'dicom.import.recovery.request');
    assert.deepEqual(requests.map(x => [x.actor, x.detail.basis, x.detail.checkedAt, x.detail.at]),
      [[ADMIN.actor, 'orthanc-log-checked', checkedAt, new Date(clock).toISOString()], [ADMIN2.actor, 'orthanc-restarted', checkedAt, new Date(clock).toISOString()]]);
    assert.deepEqual(audits(h.s, 'dicom.import.recovery.result').map(x => [x.actor, x.detail.basis, x.detail.adminSubject]), [[ADMIN2.actor, 'orthanc-restarted', ADMIN2.sub]]);
    const record = h.s.file(t.id, 1).attempts.at(-1).recovery;
    assert.deepEqual([record.adminSubject, record.basis, record.resolvedAt], [ADMIN2.sub, 'orthanc-restarted', new Date(clock).toISOString()]);
  }
  // An exact object at the re-read: Stored, holders released, no write.
  {
    const h = await harness();
    const a = await unknownAttempt(h, { stored: true });
    h.s.advance(31000);
    const postsBefore = posts(h.orthanc);
    const r = await recovery(h, a.id, { basis: 'orthanc-log-checked', checkedAt: a.attempt.startedAt });
    assert.deepEqual([r.status, r.body.outcome, h.s.claim('study:' + a.study).claim.heldByAttemptId, posts(h.orthanc), h.orthanc.count()], [200, 'stored', null, postsBefore, 1], JSON.stringify(r.body));
  }
  // A failed re-read: 503 ORTHANC_UNAVAILABLE; the result and holders unchanged, no result row; the reading right given
  // back by DB time, so the next request reads at once.
  {
    const h = await harness();
    const a = await unknownAttempt(h);
    h.s.advance(31000);
    h.orthanc.fault = call => (call.path === '/tools/lookup' ? { status: 500 } : null);
    const failed = await recovery(h, a.id, { basis: 'orthanc-log-checked', checkedAt: a.attempt.startedAt });
    h.orthanc.fault = null;
    const last = h.s.file(a.id, 0).attempts.at(-1);
    assert.deepEqual([failed.status, failed.body.code, h.s.file(a.id, 0).outcome, h.s.claim('study:' + a.study).claim.heldByAttemptId, audits(h.s, 'dicom.import.recovery.result').length],
      [503, 'ORTHANC_UNAVAILABLE', 'unconfirmed', a.attempt.attemptId, 0]);
    assert.equal(last.leaseUntil, new Date(h.s.clock).toISOString(), 'only the reading right given back');
    const again = await recovery(h, a.id, { basis: 'orthanc-log-checked', checkedAt: a.attempt.startedAt });
    assert.deepEqual([again.status, again.body.code], [200, 'RECOVERED_NO_OBJECT'], JSON.stringify(again.body));
  }
});

// ════════════════════════════════ part (c): the carried P3 of parts (a)/(b) (U4BB3-03/04/06, U4BL6-01) ════════════════════════════════

/** Source tags for a restricted policy with metadata rules: every study's PatientID is its own synthetic one. */
// Since WORKLIST-SPLIT-UID (main 848b7e5) StudyAccess.prepare reads one UID's resources through studyIdentityResources.
const metadataSource = calls => ({ studyIdentityResources: async uid => { calls.push(uid);
  return [{ '0020000D': { Value: [uid] }, '00100020': { Value: ['SYN-PID-' + uid.slice(-6)] }, '00080020': { Value: ['20261015'] }, '00080061': { Value: ['CT'] } }]; } });
/** A restricted policy whose one rule needs the source metadata and matches no study of these cases. */
const metadataPolicy = { institution: 'inst-a', policy: { version: 1, restricted: true, startsAt: null, endsAt: null,
  rules: [{ patientId: 'SYN-PID-NONE', modalities: [], dateFrom: null, dateTo: null, studyUids: [] }] } };

test('S9U4-B73 U4BB3-03 the admin recovery\'s reach lost during the Orthanc re-read is one 404 also when the new policy needs source metadata (read outside the lock) or when the admin keeps the role but is now of another institution; a lost admin role stays 403; the request row stays, no result row, holders unchanged - for both recoverable kinds', async () => {
  for (const [kind, make] of Object.entries(RECOVERABLE)) {
    for (const [mode, leave, status] of [
      ['a policy that needs metadata', h => { h.s.policies.set(ADMIN.sub, metadataPolicy); return () => h.s.policies.delete(ADMIN.sub); }, 404],
      ['another current institution, the admin role kept', h => { const r = h.s.rights.get(ADMIN.sub), was = r.institution; r.institution = 'inst-b'; return () => { r.institution = was; }; }, 404],
      ['the admin role lost', h => { const r = h.s.rights.get(ADMIN.sub), was = r.roles; r.roles = ['technician']; return () => { r.roles = was; }; }, 403],
    ]) {
      const calls = [];
      const h = await harness({ accessOrthanc: metadataSource(calls) });
      const t = await make(h);
      const missing = await recovery(h, randomUUID(), evidenceFor(h, t));
      const before = scopeView(h, t);
      let restore = null;
      h.orthanc.fault = call => { if (call.path === '/tools/lookup' && !restore) restore = leave(h); return null; };
      const r = await recovery(h, t.id, evidenceFor(h, t), ADMIN, t.index);
      h.orthanc.fault = null;
      const label = `${kind} / ${mode}`;
      assert.equal(r.status, status, `${label}: ${JSON.stringify(r.body)}`);
      if (status === 404) assert.deepEqual(r.body, missing.body, `${label}: the same 404 as an absent operation`);
      else assert.equal(r.body.message, '반입 결과 확인은 admin 권한이 필요합니다', `${label}: the existing role refusal`);
      if (mode === 'a policy that needs metadata') assert.ok(calls.includes(t.study), `${label}: the metadata of the new policy was read (outside the lock)`);
      const after = scopeView(h, t);
      assert.deepEqual([audits(h.s, 'dicom.import.recovery.request').length, audits(h.s, 'dicom.import.recovery.result').length], [1, 0], `${label}: the request row stays, no result row`);
      assert.deepEqual([after.file.outcome, after.file.code, after.file.writeDisposition], [before.file.outcome, before.file.code, before.file.writeDisposition], `${label}: the result unchanged`);
      assert.deepEqual([after.study.claim.heldByAttemptId, after.sop.claim.heldByAttemptId], [before.study.claim.heldByAttemptId, before.sop.claim.heldByAttemptId], `${label}: holders unchanged`);
      restore();
      if (kind === 'unknown') h.s.advance(31000);
      const again = await recovery(h, t.id, evidenceFor(h, t), ADMIN, t.index);
      assert.equal(again.status, 200, `${label}: recovered once back in reach (${JSON.stringify(again.body)})`);
    }
  }
});

test('S9U4-B74 U4BB3-04 a download status whose expiry scan cannot read the store is 503 IMPORT_STORAGE_UNAVAILABLE with a message that says nothing of earlier supply, no database text and the rows and checkpoints as they were; refusals, readiness and the stored-format code keep their own answers', async () => {
  const h = await harness();
  const study = await downloadStudy(h, 2), id = randomUUID();
  assert.equal((await prepare(h, study, id)).status, 200);
  const sent = await h.request('GET', archivePath(study, id), { as: RAD });
  assert.equal(sent.status, 200);
  await sleep(50);
  const stored = JSON.stringify(h.s.op(id));
  const scan = h.s.prisma.importOperation.findMany;
  h.s.prisma.importOperation.findMany = async () => { throw new Error('synthetic scan failure: relation "secret" password=x'); };
  const r = await h.request('GET', statusPath(study, id), { as: RAD });
  assert.deepEqual([r.status, r.body?.code], [503, 'IMPORT_STORAGE_UNAVAILABLE'], JSON.stringify(r.body));
  assert.ok(!JSON.stringify(r.body).includes('secret'), 'no database text');
  for (const claim of ['시작되지 않았', '보내지 않았', '전송되지 않았']) assert.ok(!r.body.message.includes(claim), `the status answer never says the past supply did not happen (${claim})`);
  assert.equal(JSON.stringify(h.s.op(id)), stored, 'the row, its attempts and checkpoints unchanged');
  // The route's own answers stay what they are while the scan is down.
  assert.equal((await h.request('GET', statusPath(study, id), { as: caller('clin-a-sub', ['clinician']) })).status, 403, 'a role refusal');
  assert.equal((await h.request('GET', statusPath(study, randomUUID()), { as: RAD })).status, 404, 'an absent operation');
  h.s.migration = false;
  assert.equal((await h.request('GET', statusPath(study, id), { as: RAD })).body.code, 'IMPORT_NOT_READY', 'readiness');
  h.s.migration = true;
  h.s.ops.get(id).download.manifestCanonical += ' ';
  assert.equal((await h.request('GET', statusPath(study, id), { as: RAD })).body.code, 'MANIFEST_STORE_INVALID', 'the stored-format code');
  h.s.prisma.importOperation.findMany = scan;
});

test('S9U4-B75 U4BB3-06 the contract 4.8 addendum codes of the download routes present in part (c) round 1, by behaviour: 409 DOWNLOAD_ALREADY_SENT (byte 0, state unchanged, a new operation prepares) and 400 IMPORT_REQUEST_INVALID for a preparation body other than the closed {operationId} (nothing prepared, no audit row)', async () => {
  const h = await harness();
  const study = await downloadStudy(h, 1), id = randomUUID();
  for (const body of [{ operationId: randomUUID(), extra: 1 }, {}, { operationId: 'not-a-uuid' }, [randomUUID()], { operationid: randomUUID() }]) {
    const before = [h.s.ops.size, audits(h.s, 'original.download.prepare').length];
    const r = await h.request('POST', `/api/studies/${study}/original-downloads`, { as: RAD, body });
    assert.deepEqual([r.status, r.body?.code], [400, 'IMPORT_REQUEST_INVALID'], JSON.stringify(body));
    assert.deepEqual([h.s.ops.size, audits(h.s, 'original.download.prepare').length], before, `${JSON.stringify(body)}: nothing prepared`);
  }
  assert.equal((await prepare(h, study, id)).status, 200);
  assert.equal((await h.request('GET', archivePath(study, id), { as: RAD })).status, 200);
  await sleep(50);
  const state = JSON.stringify(h.s.op(id));
  const again = await h.request('GET', archivePath(study, id), { as: RAD });
  assert.deepEqual([again.status, again.body?.code, again.headers['content-type']?.startsWith('application/json')], [409, 'DOWNLOAD_ALREADY_SENT', true]);
  assert.equal(JSON.stringify(h.s.op(id)), state, 'byte 0, the state unchanged');
  assert.equal((await prepare(h, study, randomUUID())).status, 200, 'a new operation prepares');
});

test('S9U4-B76 U4BL6-01 the store\'s update keeps the claimKey UNIQUE (a duplicate is refused and rolls back) and refuses what it does not model (a primary key update); a null time stamp is a not-null violation on create and on update; a product update that changes neither still commits', async () => {
  const h = await harness();
  const study = uid();
  const first = await h.send(dicom({ study }));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const claims =[...h.s.ops.values()].filter(r => r.kind === 'sop-claim');
  const second = await h.send(dicom({ study, series: study + '.2' }));
  assert.equal(second.status, 200);
  const sops = [...h.s.ops.values()].filter(r => r.kind === 'sop-claim');
  assert.equal(sops.length, claims.length + 1, 'two SOP claims');
  const [a, b] = sops;
  const snapshot = () => JSON.stringify([...h.s.ops.values()]);
  const before = snapshot();
  const db = h.s.prisma;
  await assert.rejects(db.importOperation.update({ where: { id: a.id }, data: { claimKey: b.claimKey } }), { code: 'P2002' }, 'a claimKey moved onto another row\'s');
  await assert.rejects(db.importOperation.update({ where: { id: a.id }, data: { id: randomUUID() } }), { name: 'UnmodelledStoreUpdate' }, 'a primary key update');
  await assert.rejects(db.importOperation.update({ where: { id: a.id }, data: { createdAt: null } }), { code: 'P2011' }, 'a null createdAt');
  await assert.rejects(db.importOperation.update({ where: { id: a.id }, data: { updatedAt: null } }), { code: 'P2011' }, 'a null updatedAt');
  assert.equal(snapshot(), before, 'nothing changed');
  // Inside a transaction the refusal rolls the transaction's earlier write back.
  await assert.rejects(db.$transaction(async tx => {
    await tx.importOperation.update({ where: { id: a.id }, data: { status: 'reserved' } });
    await tx.importOperation.update({ where: { id: b.id }, data: { claimKey: a.claimKey } });
  }, { isolationLevel: 'ReadCommitted', maxWait: 4000, timeout: 8000 }), { code: 'P2002' });
  assert.equal(snapshot(), before, 'the transaction rolled back');
  await assert.rejects(db.importOperation.create({ data: { id: randomUUID(), institutionId: 'inst-a', ownerIssuer: ISSUER, ownerSubject: TECH.sub, actor: TECH.actor,
    kind: 'import', status: 'open', createdAt: null } }), { code: 'P2011' }, 'a null createdAt on create');
  assert.equal(snapshot(), before, 'nothing created');
  // The same identity values written again are no change of identity: the product's own updates keep committing.
  const updated = await db.importOperation.update({ where: { id: a.id }, data: { id: a.id, claimKey: a.claimKey, updatedAt: new Date(h.s.clock) } });
  assert.equal(updated.id, a.id);
});

// ════════════════════ D1489 the archive grant (consult u4b-download-grant option A; DG-T01..T05) ════════════════════
// The product's AuthGuard in front (harness realGuard): a bound cookie session issues the grant; the browser's own GET
// carries it instead of the binding header on the exact archive route only. Every case asserts the HTTP answer, the stored
// row (format 2, active grant, uses, attempts), the audit rows and - for a refusal - that nothing ran before it.

const GRANT_RE = /^[A-Za-z0-9_-]{43}$/;
const grantDigest = raw => createHash('sha256').update('kin-original-download-grant-v1:' + raw).digest('hex');
const sessionOf = (h, sid, who = RAD) => { h.s.sessions.add(sid); h.s.sessionSubs.set(sid, who.sub); };
const boundHeaders = sid => ({ cookie: 'kin_sid=' + sid, 'x-kin-session': 'ref:' + sid });
const nativeHeaders = (sid, site = 'same-origin') => ({ cookie: 'kin_sid=' + sid, ...(site === null ? {} : { 'sec-fetch-site': site }) });
const grantRequest = (h, study, id, sid, body = {}) =>
  h.request('POST', archivePath(study, id) + '/grant', { as: null, headers: boundHeaders(sid), body });
const nativeGet = (h, study, id, raw, sid, site, method = 'GET') =>
  h.request(method, archivePath(study, id) + '?grant=' + raw, { as: null, headers: nativeHeaders(sid, site) });
async function boundPrepare(h, study, sid) {
  const id = randomUUID();
  const r = await h.request('POST', `/api/studies/${study}/original-downloads`, { as: null, headers: boundHeaders(sid), body: { operationId: id } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return id;
}
const boundStatus = (h, study, id, sid) => h.request('GET', `/api/studies/${study}/original-downloads/${id}`, { as: null, headers: boundHeaders(sid) });

test('S9U4-B77 DG-T01/T04 grant issue: a bound cookie session only (Bearer 403 DOWNLOAD_GRANT_SESSION_REQUIRED, closed {} body, owner, role), format 1 -> 2 in that transaction, only the domain-separated hash kept, 120 s by DB time, no-store/no-referrer, re-issue replaces, status summary without secrets', async () => {
  const h = await harness({ realGuard: true });
  sessionOf(h, 'sid-r1');
  const study = await downloadStudy(h, 2);
  const id = await boundPrepare(h, study, 'sid-r1');
  const v1 = h.s.op(id).download;
  assert.equal(v1.schemaVersion, 1, 'a preparation stays format 1');
  const g = await grantRequest(h, study, id, 'sid-r1');
  assert.equal(g.status, 200, JSON.stringify(g.body));
  assert.deepEqual(Object.keys(g.body).sort(), ['expiresAt', 'grant', 'grantId', 'operationId']);
  assert.match(g.body.grant, GRANT_RE);
  assert.deepEqual([g.headers['cache-control'], g.headers['referrer-policy'], g.body.operationId], ['no-store', 'no-referrer', id]);
  const d = h.s.op(id).download;
  assert.deepEqual([d.schemaVersion, d.manifestCanonical, d.attempts, d.archiveGrantUses], [2, v1.manifestCanonical, v1.attempts, []]);
  const a = d.activeArchiveGrant;
  assert.equal(a.hash, grantDigest(g.body.grant), 'the row keeps SHA-256(domain + raw) only');
  assert.deepEqual([a.grantId, a.sessionRef, a.state, a.refusal, a.operationId, a.studyUid, a.institutionId, a.ownerSubject, a.method, a.route, a.manifestSha256],
    [g.body.grantId, 'ref:sid-r1', 'issued', null, id, study, 'inst-a', RAD.sub, 'GET', 'original-archive', h.s.op(id).manifestSha256]);
  assert.deepEqual([a.issuedAt, Date.parse(a.expiresAt) - Date.parse(a.issuedAt), g.body.expiresAt], [new Date(h.s.clock).toISOString(), 120000, a.expiresAt]);
  assert.equal(h.s.op(id).status, 'prepared', 'an issued grant is not a start, nor Sent');
  const [issued] = audits(h.s, 'original.download.grant');
  assert.deepEqual([issued.target, issued.detail.phase, issued.detail.institutionId, issued.detail.grantId, issued.detail.grantHash, issued.detail.sessionRef,
    issued.detail.replacedGrantId, issued.detail.expiresAt], [study, 'issued', 'inst-a', a.grantId, a.hash, 'ref:sid-r1', null, a.expiresAt]);
  assert.ok(!JSON.stringify([...h.s.ops.values()]).includes(g.body.grant) && !JSON.stringify(h.s.audits).includes(g.body.grant), 'the raw value is stored nowhere');
  const writes = h.s.writes;
  const bearer = await h.request('POST', archivePath(study, id) + '/grant', { as: null, headers: { authorization: 'Bearer tok:' + RAD.sub }, body: {} });
  assert.deepEqual([bearer.status, bearer.body.code], [403, 'DOWNLOAD_GRANT_SESSION_REQUIRED']);
  assert.equal((await grantRequest(h, study, id, 'sid-r1', { x: 1 })).body.code, 'IMPORT_REQUEST_INVALID');
  assert.equal((await h.request('POST', archivePath(study, id) + '/grant', { as: null, headers: { cookie: 'kin_sid=sid-r1', 'x-kin-csrf': '1' }, body: {} })).status, 428, 'and its binding');
  sessionOf(h, 'sid-t2', TECH2);
  assert.equal((await grantRequest(h, study, id, 'sid-t2')).status, 404, 'another owner: the same 404 as no operation');
  sessionOf(h, 'sid-tb', TECH_B);
  assert.equal((await grantRequest(h, study, id, 'sid-tb')).status, 404, 'another institution');
  h.s.rights.set('clin-a-sub', { sub: 'clin-a-sub', approved: true, suspended: false, institution: 'inst-a', roles: ['clinician'] });
  h.s.sessions.add('sid-c'); h.s.sessionSubs.set('sid-c', 'clin-a-sub');
  assert.equal((await grantRequest(h, study, id, 'sid-c')).status, 403, 'a clinician-only member never reaches the route');
  const gateway = await h.request('POST', archivePath(study, id) + '/grant', { as: null, headers: { authorization: 'Bearer tok:gw-sub' }, body: {} });
  assert.ok([401, 403].includes(gateway.status), 'no Gateway grant: ' + gateway.status + ' ' + JSON.stringify(gateway.body));
  assert.equal(h.s.writes, writes, 'no refusal wrote anything');
  const g2 = await grantRequest(h, study, id, 'sid-r1');
  assert.notEqual(g2.body.grantId, g.body.grantId);
  assert.deepEqual([h.s.op(id).download.activeArchiveGrant.grantId, audits(h.s, 'original.download.grant')[1].detail.replacedGrantId], [g2.body.grantId, g.body.grantId], 'a new issue replaces the unused one');
  const status = await boundStatus(h, study, id, 'sid-r1');
  assert.deepEqual(status.body.archiveRequest, { grantId: g2.body.grantId, state: 'issued', expiresAt: g2.body.expiresAt, attemptId: null, code: null, message: null });
  for (const secret of [g2.body.grant, grantDigest(g2.body.grant), 'ref:sid-r1']) assert.ok(!JSON.stringify(status.body).includes(secret), 'no raw value, hash or session reference in the status');
  h.s.advance(120000);
  const later = (await boundStatus(h, study, id, 'sid-r1')).body.archiveRequest;
  assert.deepEqual(later, status.body.archiveRequest, 'issuance metadata does not expire an unused download');
  const sent = await h.request('GET', archivePath(study, id), { as: null, headers: nativeHeaders('sid-r1') });
  assert.equal(sent.status, 200);
  h.s.advance(120000);
  const afterSent = (await boundStatus(h, study, id, 'sid-r1')).body;
  assert.equal(afterSent.state, 'sent');
  assert.deepEqual(afterSent.archiveRequest, status.body.archiveRequest, 'Sent remains Sent without a grant-expired error');
});

// ════════════ WORKLIST-SPLIT-UID hand-over (main 848b7e5; spec §5 U4b rows, TEST-WSU-11; Phase B I-01/I-02) ════════════
// A Study UID that two original resources answer (here: a second PatientID under it, which the fake keys as a second
// Orthanc study, as Orthanc does). The download routes observe the source per request outside any transaction and refuse
// such a UID after their scope checks; the import path never pre-checks it: its own identity gate decides.

test('S9U4-B81 WSU I-01 download replay, start and preparation of a Study UID two original resources answer: 409 STUDY_IDENTITY_UNRESOLVED, ZIP byte 0, refusal recorded, the operation as it was (prepared before the split included); the source read outside any transaction; an unobservable source 503 STUDY_SOURCE_UNAVAILABLE; scope refusals first and never telling the split; an ordinary download unchanged', async () => {
  const h = await harness();
  const study = await downloadStudy(h, 2);
  const id = randomUUID();
  const first = await prepare(h, study, id);
  assert.deepEqual([first.status, first.body.state], [200, 'prepared'], 'one resource: prepared as before');
  assert.ok(h.orthanc.sourceReads.some(r => r.studyUid === study), 'the preparation observed the source');
  // The UID becomes split after the preparation: another patient's original under the same Study UID.
  h.orthanc.store(dicom({ study, series: study + '.9', id: 'SYN-OTHER', pixel: 80 }));
  const before = JSON.stringify(h.s.op(id)), writes = h.s.writes, reads = h.orthanc.sourceReads.length;
  const replay = await prepare(h, study, id);
  assert.deepEqual([replay.status, replay.body?.code], [409, 'STUDY_IDENTITY_UNRESOLVED'], 'the replay of the prepared operation');
  const start = await h.request('GET', archivePath(study, id), { as: RAD });
  assert.deepEqual([start.status, start.body?.code, String(start.headers['content-type']).startsWith('application/json')],
    [409, 'STUDY_IDENTITY_UNRESOLVED', true], 'the start of the operation prepared before the split: byte 0, never a ZIP');
  assert.equal(JSON.stringify(h.s.op(id)), before, 'the operation as it was: prepared, no attempt');
  assert.equal(audits(h.s, 'original.download.intent').length, 0, 'no intent');
  const fresh = randomUUID();
  const refused = await prepare(h, study, fresh);
  assert.deepEqual([refused.status, refused.body?.code, h.s.ops.has(fresh)], [409, 'STUDY_IDENTITY_UNRESOLVED', false], 'no new preparation');
  assert.equal(h.s.writes, writes + 1, 'only the archive refusal is recorded');
  assert.deepEqual(audits(h.s, 'original.download.refused').map(a => a.detail.code), ['STUDY_IDENTITY_UNRESOLVED']);
  assert.ok(h.orthanc.sourceReads.length >= reads + 3, 'each request observed the source itself');
  assert.ok(h.orthanc.sourceReads.every(r => r.openTransactions === 0), 'every source read outside any transaction');
  // Scope first: another owner's operation, another institution's member and an absent study are the 404s they were.
  for (const [what, answer] of [
    ['another owner', await h.request('GET', archivePath(study, id), { as: TECH2 })],
    ['another institution', await prepare(h, study, randomUUID(), TECH_B)],
    ['an absent study', await prepare(h, uid(), randomUUID())],
  ]) {
    assert.equal(answer.status, 404, what);
    assert.ok(!JSON.stringify(answer.body ?? {}).includes('STUDY_IDENTITY_UNRESOLVED'), what + ': the split is not told');
  }
  // A source that cannot be observed: 503, byte 0, nothing written; the operation starts once it can be observed.
  const other = await downloadStudy(h, 1);
  const otherId = randomUUID();
  assert.equal((await prepare(h, other, otherId)).status, 200);
  h.orthanc.sourceFault = true;
  const unobserved = await h.request('GET', archivePath(other, otherId), { as: RAD });
  assert.deepEqual([unobserved.status, unobserved.body?.code, h.s.op(otherId).status], [503, 'STUDY_SOURCE_UNAVAILABLE', 'prepared']);
  assert.equal((await prepare(h, other, randomUUID())).body?.code, 'STUDY_SOURCE_UNAVAILABLE');
  h.orthanc.sourceFault = false;
  const zip = await h.request('GET', archivePath(other, otherId), { as: RAD });
  assert.deepEqual([zip.status, parseZipEntries(zip.bytes).length], [200, 2], 'an ordinary download of a one-resource UID is unchanged');
  await sleep(50);
  assert.equal(h.s.op(otherId).status, 'sent');
});

test('S9U4-B82 WSU I-01 with the archive grant: a start refused for a split Study UID records the refusal (STUDY_IDENTITY_UNRESOLVED), opens no attempt and sends byte 0; an unobservable source leaves the grant as it was', async () => {
  const h = await harness({ realGuard: true });
  sessionOf(h, 'sid-r1');
  const study = await downloadStudy(h, 2);
  const id = await boundPrepare(h, study, 'sid-r1');
  const raw = (await grantRequest(h, study, id, 'sid-r1')).body.grant;
  h.orthanc.sourceFault = true;
  const unobserved = await nativeGet(h, study, id, raw, 'sid-r1');
  assert.deepEqual([unobserved.status, unobserved.body?.code], [503, 'STUDY_SOURCE_UNAVAILABLE'],
    'a storage-like answer decides nothing: the grant stays issued');
  h.orthanc.sourceFault = false;
  h.orthanc.store(dicom({ study, series: study + '.9', id: 'SYN-OTHER', pixel: 80 }));
  const split = await nativeGet(h, study, id, raw, 'sid-r1');
  assert.deepEqual([split.status, split.body?.code, String(split.headers['content-type']).startsWith('application/json')], [409, 'STUDY_IDENTITY_UNRESOLVED', true]);
  const d = h.s.op(id).download;
  assert.deepEqual([d.attempts.length, h.s.op(id).status], [0, 'prepared']);
});

test('S9U4-B83 WSU I-02 the import path is not pre-checked for a split: an existing Study UID two patients answer reaches the import gate in both store orders - registered: 409 EXISTING_STUDY_IDENTITY_UNRESOLVED; unregistered: the gate\'s own ownership answer - with no source observation, zero new originals, no claim and every stored original byte for byte; StudyAccess.require refuses no split', async () => {
  for (const registered of [true, false]) for (const order of [['SYN-X', 'SYN-Y'], ['SYN-Y', 'SYN-X']]) {
    const h = await harness();
    const study = uid();
    for (const [i, patient] of order.entries()) h.orthanc.store(dicom({ study, series: study + '.' + (i + 1), id: patient }));
    if (registered) own(h.s, study);
    const stored = new Map([...h.orthanc.instances.values()].map(i => [i.id, sha(i.bytes)]));
    const reads = h.orthanc.sourceReads.length, posted = posts(h.orthanc);
    const r = await h.send(dicom({ study, series: study + '.9', id: order[0] }));
    const label = (registered ? 'registered ' : 'unregistered ') + order.join('/');
    if (registered) assert.deepEqual([r.status, r.body.outcome, r.body.code], [409, 'rejected', 'EXISTING_STUDY_IDENTITY_UNRESOLVED'], label);
    else assert.deepEqual([r.status, r.body.code], [409, 'STUDY_OWNERSHIP_UNDETERMINED'], label + ': the gate decides ownership first');
    assert.notEqual(r.body.code, 'STUDY_IDENTITY_UNRESOLVED', label + ': never the download routes\' split refusal');
    assert.equal(h.orthanc.sourceReads.length, reads, label + ': the import observes no source of its own');
    assert.deepEqual([posts(h.orthanc), h.orthanc.count(), h.s.claim('study:' + study)], [posted, stored.size, null], label + ': zero writes, no claim');
    assert.deepEqual(new Map([...h.orthanc.instances.values()].map(i => [i.id, sha(i.bytes)])), stored, label + ': every original byte for byte');
    // The shared StudyAccess requirement has no split rule: an unrestricted member is allowed this UID.
    if (registered) await h.transfer.studyAccess.require(TECH, [study]);
  }
});

test('S9U4-B84 U4C-05 DG-T03 a right lost between the start\'s preflight and its operation lock is refused inside the consume transaction - a role lost, the member\'s institution changed, the study moved out of the institution: no grant use, no attempt, no intent, byte 0, the grant closed as refused and the operation still prepared; the same start with the rights unchanged still opens and finishes', async () => {
  for (const change of ['role', 'institution', 'study']) {
    const h = await harness({ realGuard: true });
    sessionOf(h, 'sid-race');
    const study = await downloadStudy(h, 1);
    const id = await boundPrepare(h, study, 'sid-race');
    const raw = (await grantRequest(h, study, id, 'sid-race')).body.grant;
    const rights = h.s.rights.get(RAD.sub), state = h.s.states.get(study);
    let changed = false;
    // The change lands after the preflight's reads and before the consume transaction's lock answers (its first read).
    h.s.onQuery = async (sql, values, tx) => {
      if (!changed && tx && sql.includes('SELECT * FROM "ImportOperation"') && values.includes(id)) {
        changed = true;
        if (change === 'role') h.s.rights.set(RAD.sub, { ...rights, roles: ['clinician'] });
        else if (change === 'institution') h.s.rights.set(RAD.sub, { ...rights, institution: 'inst-b' });
        else h.s.states.set(study, { ...state, institutionId: 'inst-b' });
      }
    };
    let r;
    try { r = await nativeGet(h, study, id, raw, 'sid-race'); } finally { h.s.onQuery = null; }
    await sleep(80);
    assert.ok(changed, change + ': the change reached the lock');
    assert.ok([403, 404].includes(r.status), change + ': refused, ' + r.status + ' ' + JSON.stringify(r.body));
    assert.ok(String(r.headers['content-type']).startsWith('application/json'), change + ': byte 0, never a ZIP');
    const d = h.s.op(id).download;
    assert.deepEqual([d.archiveGrantUses.length, d.attempts.length, audits(h.s, 'original.download.intent').length, h.s.op(id).status],
      [0, 0, 0, 'prepared'], change + ': nothing consumed or opened');
    h.s.rights.set(RAD.sub, rights);
    h.s.states.set(study, state);
    const again = (await grantRequest(h, study, id, 'sid-race')).body.grant;
    const zip = await nativeGet(h, study, id, again, 'sid-race');
    assert.deepEqual([zip.status, parseZipEntries(zip.bytes).length], [200, 2], change + ': unchanged rights open the start (the manifest and the one original)');
    await sleep(50);
    assert.equal(h.s.op(id).status, 'sent');
  }
});

test('S9U4-B85 SRU4R3-7 the archive start is the operation\'s own study only: a route Study UID other than the operation\'s is the operation\'s 404 at the preflight, and an operation row whose Study UID differs from the route\'s when the consume lock answers is refused there - no grant use, no attempt, no intent, byte 0', async () => {
  // Bearer: the route's UID differs from the operation's from the start.
  const h = await harness();
  const a = await downloadStudy(h, 1), b = await downloadStudy(h, 1);
  const id = randomUUID();
  assert.equal((await prepare(h, a, id)).status, 200);
  const wrong = await h.request('GET', archivePath(b, id), { as: RAD });
  assert.deepEqual([wrong.status, String(wrong.headers['content-type']).startsWith('application/zip')], [404, false], 'another study\'s route: 404, byte 0');
  // The row's Study UID seen differently once the lock answers (Bearer, then a grant).
  for (const viaGrant of [false, true]) {
    const g = viaGrant ? await harness({ realGuard: true }) : h;
    if (viaGrant) sessionOf(g, 'sid-uid');
    const sa = viaGrant ? await downloadStudy(g, 1) : a, sb = viaGrant ? await downloadStudy(g, 1) : b;
    const op = viaGrant ? await boundPrepare(g, sa, 'sid-uid') : randomUUID();
    if (!viaGrant) assert.equal((await prepare(g, sa, op)).status, 200);
    const raw = viaGrant ? (await grantRequest(g, sa, op, 'sid-uid')).body.grant : null;
    // A well-formed row of the same owner prepared for study B stands in for the operation's row once the lock answers
    // (a row that is not well formed would be the store-format 503 first).
    const other = viaGrant ? await boundPrepare(g, sb, 'sid-uid') : randomUUID();
    if (!viaGrant) assert.equal((await prepare(g, sb, other)).status, 200);
    const row = g.s.ops.get(op), original = JSON.parse(JSON.stringify(row));
    let swapped = false;
    g.s.onQuery = async (sql, values, tx) => {
      if (!swapped && tx && sql.includes('SELECT * FROM "ImportOperation"') && values.includes(op)) {
        swapped = true; Object.assign(row, JSON.parse(JSON.stringify(g.s.ops.get(other))), { id: op });
      }
    };
    let r;
    try { r = viaGrant ? await nativeGet(g, sa, op, raw, 'sid-uid') : await g.request('GET', archivePath(sa, op), { as: RAD }); }
    finally { g.s.onQuery = null; for (const k of Object.keys(row)) delete row[k]; Object.assign(row, original); }
    await sleep(80);
    const label = viaGrant ? 'grant' : 'bearer';
    assert.ok(swapped, label + ': the row changed when the lock answered');
    assert.deepEqual([r.status, String(r.headers['content-type']).startsWith('application/zip')], [404, false], label + ': refused under the lock, byte 0');
    const d = g.s.op(op).download;
    assert.deepEqual([d.attempts.length, (d.archiveGrantUses ?? []).length, audits(g.s, 'original.download.intent').filter(x => x.detail.operationId === op).length, g.s.op(op).status],
      [0, 0, 0, 'prepared'], label + ': nothing consumed or opened');
  }
  assert.equal(audits(h.s, 'original.download.intent').length, 0, 'no intent at all in the bearer harness');
});

test('S9U4-B86 D1574 the import answer shapes the page reads, as the real service answers them: a stored and a STUDY_WRITE_PENDING POST (409, retryable, generation 0, no attempt), the status envelope and its rows, an attempt, a request-level refusal - exactly the keys of tests/fixtures/s9u4-import-envelope.json (the DOM fixture is pinned to the same file)', async () => {
  const shape = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures', 's9u4-import-envelope.json'), 'utf8'));
  const keys = o => Object.keys(o).sort();
  const h = await harness();
  const study = uid();
  const stored = await h.send(dicom({ study, series: study + '.1', id: 'SYN-ENV' }));
  assert.equal(stored.status, 200, JSON.stringify(stored.body));
  assert.deepEqual(keys(stored.body), shape.post_file, 'a stored POST answer');
  assert.deepEqual(keys(stored.body.attempts[0]), shape.attempt, 'an attempt');
  // A Study held by a live attempt: the second file is STUDY_WRITE_PENDING before any attempt (the live REQ-S9-U4-10 case).
  const busy = uid(), busySop = uid();
  let release, held;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { held = resolve; });
  h.orthanc.fault = async call => {
    if (call.path === '/tools/lookup' && call.body.toString() === busySop) { held(); await gate; }
    return null;
  };
  const slow = h.send(dicom({ study: busy, series: busy + '.1', sop: busySop, id: 'SYN-ENV2' }));
  let readyTimer;
  try {
    await Promise.race([ready, new Promise((_, reject) => {
      readyTimer = setTimeout(() => reject(new Error('B86 held lookup did not arrive')), 5000);
    })]);
    clearTimeout(readyTimer);
    const pending = await h.send(dicom({ study: busy, series: busy + '.1', id: 'SYN-ENV2' }), { as: TECH2 });
    assert.deepEqual([pending.status, pending.body.outcome, pending.body.code, pending.body.generation, pending.body.attempts, pending.body.writeDisposition, pending.body.identity],
      [409, 'retryable', 'STUDY_WRITE_PENDING', 0, [], null, null], 'a pre-attempt retryable: generation 0, no attempt');
    assert.deepEqual(keys(pending.body), shape.post_file, 'the retryable POST answer has every key');
    const status = await h.request('GET', '/api/dicom-import/' + pending.id, { as: TECH2 });
    assert.equal(status.status, 200);
    assert.deepEqual(keys(status.body), shape.status_envelope, 'the status envelope');
    assert.deepEqual(keys(status.body.files[0]), shape.status_file, 'a status row');
    assert.deepEqual([status.body.files[0].generation, status.body.files[0].outcome], [0, 'retryable'], 'the row of a pre-attempt retryable');
  } finally {
    clearTimeout(readyTimer);
    release();
    await slow;
    h.orthanc.fault = null;
  }
  const refused = await h.request('POST', '/api/dicom-import', { as: TECH, headers: { 'Content-Type': 'application/dicom', 'X-KIN-Operation-Id': 'bad', 'X-KIN-File-Index': '0' }, body: Buffer.from('x') });
  assert.deepEqual([refused.status, keys(refused.body)], [400, shape.request_refusal], 'a request-level refusal');
});

test('S9U4-B87 D1668 r6 the positive histories the page accepts, as the real service writes them: a no-write retry (its own code, certain-no-write, an end time) then Stored, and a resolved no-object recovery whose checkedAt has no fractional seconds then Stored, on the POST and on the status GET', async () => {
  const keys = o => Object.keys(o).sort();
  const serverTime = v => typeof v === 'string' && new Date(v).toISOString() === v;
  const row = answer => Object.fromEntries(Object.entries(answer).filter(([k]) => k !== 'operationId'));
  const h = await harness();
  const study = uid(), series = study + '.1', sop = uid();
  own(h.s, study, 'inst-a', 'gateway');
  h.orthanc.fault = call => (call.path.endsWith('/tools/lookup') ? { status: 500 } : null);
  const bytes = dicom({ study, series, sop, id: 'SYN-B87' });
  const first = await h.send(bytes);
  assert.deepEqual([first.status, first.body.outcome, first.body.code], [503, 'retryable', 'ORTHANC_UNAVAILABLE']);
  h.orthanc.fault = null;
  const stored = await h.send(bytes, { id: first.id });
  assert.deepEqual([stored.status, stored.body.outcome, stored.body.generation, stored.body.attempts.length], [200, 'stored', 2, 2]);
  const [retried, last] = stored.body.attempts;
  assert.deepEqual([retried.generation, retried.phase, retried.outcome, retried.code, retried.transport, retried.recovery],
    [1, 'finished', 'retryable', 'ORTHANC_UNAVAILABLE', 'certain-no-write', null], 'a no-write retry before the positive');
  assert.ok(serverTime(retried.startedAt) && serverTime(retried.finishedAt), 'its server times are canonical');
  assert.deepEqual([last.generation, last.phase, last.outcome, last.code, last.transport], [2, 'finished', 'stored', null, null]);
  const status = await h.request('GET', '/api/dicom-import/' + first.id);
  assert.deepEqual(status.body.files, [row(stored.body)], 'the status row is the same history');

  const lost = await unknownAttempt(h);
  h.s.advance(31000);
  const checkedAt = new Date(T0 + 1000).toISOString().replace('.000Z', 'Z');
  const recovered = await recovery(h, lost.id, { basis: 'orthanc-restarted', checkedAt });
  assert.deepEqual([recovered.status, recovered.body.outcome, recovered.body.code], [200, 'retryable', 'RECOVERED_NO_OBJECT']);
  const again = await h.send(lost.bytes, { id: lost.id });
  assert.deepEqual([again.status, again.body.outcome, again.body.generation, again.body.attempts.length], [200, 'stored', 2, 2]);
  const [noObject, after] = again.body.attempts;
  assert.deepEqual([noObject.phase, noObject.outcome, noObject.code, keys(noObject.recovery)],
    ['finished', 'retryable', 'RECOVERED_NO_OBJECT', ['basis', 'checkedAt', 'requestedAt', 'resolvedAt']]);
  assert.notEqual(noObject.transport, 'certain-no-write', 'its transport stays as the dispatch left it');
  assert.equal(noObject.recovery.checkedAt, checkedAt, 'the admin instant is kept without fractional seconds');
  assert.ok(serverTime(noObject.recovery.requestedAt) && serverTime(noObject.recovery.resolvedAt) && serverTime(noObject.finishedAt),
    'the recovery is resolved, with canonical server times');
  assert.deepEqual([after.phase, after.outcome, after.code, after.transport], ['finished', 'stored', null, null]);
  const read = await h.request('GET', '/api/dicom-import/' + lost.id);
  assert.deepEqual(read.body.files, [row(again.body)], 'the status row is the same history');
});

test('S9U4-B88 D1691 /api/me names the login server exactly as the transfer service keys the owner: two configured issuers with the same institution and subject give two me.issuer values, each equal to the ownerIssuer of the operation it opens; none configured gives null and no operation', async () => {
  const { PacsController } = require('/app/dist/pacs.controller');
  // The product's own GET me handler over the request fields its guard sets (the TestGuard here sets the same ones).
  const me = as => new PacsController(null, null).me({ sub: as.sub, actor: as.actor, roles: as.roles, institution: as.institution,
    kind: as.kind, sessionId: 'SYN-SESSION' });
  const h = await harness();
  const saved = process.env.KC_ISSUER;
  const seen = [];
  try {
    for (const issuer of ['https://syn-a.test/auth/realms/kin', 'https://syn-b.test/auth/realms/kin']) {
      process.env.KC_ISSUER = issuer;
      const answer = me(TECH);
      assert.equal(answer.issuer, issuer, 'me.issuer is the configured login server as it is');
      assert.deepEqual([answer.institution, answer.sub], [TECH.institution, TECH.sub], 'the same institution and subject');
      const stored = await h.send(dicom({ study: uid() }));
      assert.equal(stored.status, 200, JSON.stringify(stored.body));
      assert.equal(h.s.op(stored.id).ownerIssuer, answer.issuer, 'the operation owner carries the login server me names');
      seen.push(answer.issuer);
    }
    assert.notEqual(seen[0], seen[1], 'two login servers stay two owners for the page');
    delete process.env.KC_ISSUER;
    assert.equal(me(TECH).issuer, null, 'no configured login server: me names none');
    const refused = await h.send(dicom({ study: uid() }));
    assert.deepEqual([refused.status, refused.body.code], [503, 'IMPORT_ISSUER_UNCONFIGURED'], 'and the service opens no operation');
  } finally {
    if (saved === undefined) delete process.env.KC_ISSUER; else process.env.KC_ISSUER = saved;
  }
});

test('PC3 native archive GET admits a cookie session without a header; other routes and mismatched documents stay bound', async () => {
  const h = await harness({ realGuard: true });
  sessionOf(h, 'sid-native');
  const study = await downloadStudy(h, 2);
  const id = await boundPrepare(h, study, 'sid-native');
  const options = { as: null, headers: { cookie: 'kin_sid=sid-native' } };
  assert.equal((await h.request('GET', archivePath(study, id), { as: null })).status, 401);
  assert.equal((await h.request('GET', archivePath(study, id), { as: null, headers: { ...options.headers, 'x-kin-session': 'ref:another' } })).status, 409);
  assert.equal((await h.request('HEAD', archivePath(study, id), options)).status, 428);
  assert.equal((await h.request('GET', '/api/studies/' + study + '/original-downloads/' + id, options)).status, 428);
  const zip = await h.request('GET', archivePath(study, id), options);
  assert.equal(zip.status, 200, JSON.stringify(zip.body));
  assert.equal(parseZipEntries(zip.bytes).length, 3);
  await sleep(80);
  assert.equal(h.s.op(id).status, 'sent');
  assert.equal(audits(h.s, 'original.download.intent').length, 1);
});

test('PC3 native archive GET refused before supply is byte 0 with no attempt (manifest changed, rights lost, logged out); Sent only from the server finish; format 2 read strictly', async () => {
  const h = await harness({ realGuard: true });
  sessionOf(h, 'sid-r1');
  const native = (study, id) => h.request('GET', archivePath(study, id), { as: null, headers: { cookie: 'kin_sid=sid-r1' } });
  const study = await downloadStudy(h, 2);
  const id = await boundPrepare(h, study, 'sid-r1');
  h.orthanc.store(dicom({ study, series: study + '.9', id: 'SYN-D', pixel: 90 }));
  const changed = await native(study, id);
  assert.deepEqual([changed.status, changed.body?.code, String(changed.headers['content-type']).startsWith('application/json')], [409, 'MANIFEST_CHANGED', true], 'byte 0: the refusal, never a ZIP');
  assert.equal(h.s.op(id).download.attempts.length, 0);
  // Rights lost after the preparation: the guard's own rights read refuses the GET before the handler.
  const study2 = await downloadStudy(h, 1);
  const id2 = await boundPrepare(h, study2, 'sid-r1');
  h.s.rights.set(RAD.sub, { ...h.s.rights.get(RAD.sub), roles: ['clinician'] });
  assert.equal((await native(study2, id2)).status, 403);
  assert.equal(h.s.op(id2).download.attempts.length, 0);
  h.s.rights.set(RAD.sub, { ...h.s.rights.get(RAD.sub), roles: ['radiologist'] });
  // A logged-out session: authentication refuses it as for any request.
  h.s.sessions.delete('sid-r1');
  assert.equal((await native(study2, id2)).status, 401);
  sessionOf(h, 'sid-r1');
  assert.equal(audits(h.s, 'original.download.intent').length, 0, 'no intent, no attempt');
  // Sent is the server's own finish after the last byte.
  assert.equal((await native(study2, id2)).status, 200);
  await sleep(50);
  assert.deepEqual([h.s.op(id2).status, audits(h.s, 'original.download.result').filter(a => a.detail.operationId === id2).map(a => a.detail.state)], ['sent', ['sent']]);
  // Format 2 is closed: an unknown key in the stored JSON is 503 MANIFEST_STORE_INVALID on the status and the archive.
  const study3 = await downloadStudy(h, 1);
  const id3 = await boundPrepare(h, study3, 'sid-r1');
  assert.equal((await grantRequest(h, study3, id3, 'sid-r1')).status, 200, 'the grant issue converts the row to format 2');
  h.s.ops.get(id3).download.archiveGrantNote = 'synthetic';
  assert.deepEqual([(await boundStatus(h, study3, id3, 'sid-r1')).body.code, (await native(study3, id3)).body.code], ['MANIFEST_STORE_INVALID', 'MANIFEST_STORE_INVALID']);
  delete h.s.ops.get(id3).download.archiveGrantNote;
  h.s.ops.get(id3).download.schemaVersion = 3;
  assert.equal((await boundStatus(h, study3, id3, 'sid-r1')).body.code, 'MANIFEST_STORE_INVALID', 'an unknown version is never read as another');
});
