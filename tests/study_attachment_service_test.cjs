'use strict';
/* FC-076 Attach Document: the API's attach, list and withdraw against a synthetic Orthanc on 127.0.0.1 that records every
 * request and answers like Orthanc 1.12.5 (`/tools/lookup` with a plain-text UID, `/tools/create-dicom` answering
 * `{ID, Path}` and inheriting the patient and study modules from its Parent study, `/instances/{id}`, `/series/{id}`,
 * `/instances/{id}/simplified-tags`, `/instances/{id}/content/0042-0011`). The database, StudyAccess and the access
 * ledger are in-memory stand-ins; every access record is checked by the contract's own parser (parseAccessEvent).
 * The serving paths (DICOMweb gate, metadata relay, original download manifest) are run against the same rows.
 * No DB, credentials or external network.
 */
require('./service_test_loader.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID, createHash } = require('node:crypto');
const zlib = require('node:zlib');

process.env.ORTHANC_USER = process.env.ORTHANC_USER || 'SYN';
process.env.ORTHANC_PASS = process.env.ORTHANC_PASS || 'SYN';

const UID = '1.2.826.0.1.3680043.8.498.761', RECEIVED = '1.2.826.0.1.3680043.8.498.762', FOREIGN = '1.2.826.0.1.3680043.8.498.763';
const STUDY_ID = 'aaaaaaaa-bbbbbbbb-cccccccc-dddddddd-eeeeeeee';
const OTHER_UID = '1.2.826.0.1.3680043.8.498.764', OTHER_ID = 'bbbbbbbb-bbbbbbbb-cccccccc-dddddddd-eeeeeeee', OTHER_SERIES = '1.2.826.0.1.3680043.8.498.764.9';
const TECH = { sub: 'sub-tech', actor: 'SYN-tech', roles: ['technician'], institution: 'inst-a', kind: 'member' };
const RAD = { sub: 'sub-rad', actor: 'SYN-rad', roles: ['radiologist'], institution: 'inst-a', kind: 'member' };
const ADMIN = { sub: 'sub-admin', actor: 'SYN-admin', roles: ['admin'], institution: 'inst-a', kind: 'member' };
const CLIN = { sub: 'sub-clin', actor: 'SYN-clin', roles: ['clinician'], institution: 'inst-a', kind: 'member' };
const OTHER = { sub: 'sub-other', actor: 'SYN-other', roles: ['technician'], institution: 'inst-b', kind: 'member' };
const GATEWAY = { sub: 'sub-gw', actor: 'SYN-gw', roles: ['gateway'], institution: 'inst-a', kind: 'gateway' };

/**
 * A real PNG (deflate, filter types as asked) of width x height whose pixel (x, y) is synthetic; `color` 2 = RGB,
 * 6 = RGBA (alpha varies, which Orthanc drops), 0 = grey. Also returns the pixels as Orthanc stores them.
 */
function png(width, height, { color = 2, filters = [0], depth = 8 } = {}) {
  const channels = { 0: 1, 2: 3, 6: 4 }[color], stored = color === 0 ? 1 : 3;
  const rows = [], pixels = Buffer.alloc(width * height * stored);
  for (let y = 0; y < height; y++) {
    const line = Buffer.alloc(width * channels);
    for (let x = 0; x < width; x++) {
      const v = [(x * 37 + y * 11) & 255, (x * 5 + y * 71) & 255, (x * y * 3 + 40) & 255, (x * 13 + 200) & 255];
      for (let c = 0; c < channels; c++) line[x * channels + c] = v[c];
      for (let c = 0; c < stored; c++) pixels[(y * width + x) * stored + c] = v[c];
    }
    const filter = filters[y % filters.length], out = Buffer.alloc(line.length);
    for (let i = 0; i < line.length; i++) {
      const a = i >= channels ? line[i - channels] : 0, b = y ? rows[y - 1].line[i] : 0, c = y && i >= channels ? rows[y - 1].line[i - channels] : 0;
      const p = a + b - c, pick = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      out[i] = (line[i] - [0, a, b, (a + b) >> 1, pick][filter]) & 255;
    }
    rows.push({ line, encoded: Buffer.concat([Buffer.from([filter]), out]) });
  }
  const chunk = (kind, data) => { const head = Buffer.alloc(4); head.writeUInt32BE(data.length); return Buffer.concat([head, Buffer.from(kind), data, Buffer.alloc(4)]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = depth; ihdr[9] = color;
  const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows.map(r => r.encoded)))), chunk('IEND', Buffer.alloc(0))]);
  PIXELS.set(bytes.toString('base64'), { pixels, samples: stored });
  return bytes;
}
/** The decoded pixels of every PNG this suite made: what a decoder (the synthetic Orthanc's) stores for it. */
const PIXELS = new Map();
/** A JPEG with an APP0 segment then a baseline start-of-frame naming height x width. */
function jpeg(width, height) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}
const PDF = Buffer.from('%PDF-1.4\n% SYN synthetic document\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');  // odd length on purpose

function sizeOf(bytes) {
  if (bytes[0] === 0x89) return { Columns: String(bytes.readUInt32BE(16)), Rows: String(bytes.readUInt32BE(20)) };
  const at = bytes.indexOf(Buffer.from([0xff, 0xc0]));
  return { Rows: String(bytes.readUInt16BE(at + 5)), Columns: String(bytes.readUInt16BE(at + 7)) };
}

/**
 * A synthetic Orthanc holding one study (UID under STUDY_ID) and another (OTHER_UID under OTHER_ID). `state.mode` steers
 * create-dicom: refuse, void (answer lost, nothing written), lost (written, answer lost), wrongPatient, wrongPixels,
 * otherParent (written under the other study, in another series).
 */
async function orthanc(t) {
  const state = { mode: 'ok', requests: [], creates: [], instances: new Map(), patientId: 'P-SYN-1', patientName: 'SYN^PATIENT' };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    state.requests.push({ method: req.method, url: req.url, contentType: req.headers['content-type'], raw });
    const send = (status, value, type = 'application/json') => {
      const body = Buffer.isBuffer(value) ? value : Buffer.from(value === undefined ? '' : JSON.stringify(value));
      res.writeHead(status, { 'Content-Type': type, 'Content-Length': body.length }); res.end(body);
    };
    if (req.url === '/tools/lookup' && req.method === 'POST') {
      if (raw === UID) return send(200, [{ Type: 'Study', ID: STUDY_ID, Path: '/studies/' + STUDY_ID }]);
      const hit = [...state.instances.values()].find(i => i.tags.SOPInstanceUID === raw);
      return send(200, hit ? [{ Type: 'Instance', ID: hit.id, Path: '/instances/' + hit.id }] : []);
    }
    if (req.url === '/studies/' + STUDY_ID) return send(200, { ID: STUDY_ID, MainDicomTags: { StudyInstanceUID: UID },
      PatientMainDicomTags: { PatientID: state.patientId, PatientName: state.patientName } });
    if (req.url === '/tools/create-dicom' && req.method === 'POST') {
      const body = JSON.parse(raw); state.creates.push(body);
      if (state.mode === 'refuse') return send(400, { Message: 'SYN bad request' });
      if (state.mode === 'void') { res.destroy(); return; }   // the answer is lost and nothing was written
      const [, mime, b64] = /^data:([^;]+);base64,(.*)$/s.exec(body.Content);
      const content = Buffer.from(b64, 'base64'), id = createHash('sha1').update(randomUUID()).digest('hex').replace(/(.{8})(?!$)/g, '$1-');
      const elsewhere = state.mode === 'otherParent';
      const tags = { ...body.Tags, StudyInstanceUID: elsewhere ? OTHER_UID : body.Parent === STUDY_ID ? UID : 'unknown',
        ...(elsewhere ? { SeriesInstanceUID: OTHER_SERIES } : {}),
        PatientID: state.mode === 'wrongPatient' ? 'P-SYN-OTHER' : state.patientId, PatientName: state.patientName,
        ...(mime === 'application/pdf' ? { MIMETypeOfEncapsulatedDocument: 'application/pdf' } : sizeOf(content)) };
      let pixels = null;
      if (mime === 'image/png') {
        const known = PIXELS.get(b64);
        pixels = Buffer.from(known.pixels); tags.SamplesPerPixel = String(known.samples);
        if (state.mode === 'wrongPixels') pixels[0] ^= 0xff;
      } else if (mime === 'image/jpeg') tags.SamplesPerPixel = '3';
      const series = 'ffffffff-' + id.slice(9);
      state.instances.set(id, { id, series, parent: elsewhere ? OTHER_ID : body.Parent, tags, pixels, document: mime === 'application/pdf'
        ? (content.length % 2 ? Buffer.concat([content, Buffer.from([0])]) : content) : null });
      if (state.mode === 'lost') { res.destroy(); return; }
      return send(200, { ID: id, Path: '/instances/' + id });
    }
    const inst = /^\/instances\/([0-9a-f-]+)(\/simplified-tags|\/content\/0042-0011|\/frames\/0\/raw)?$/.exec(req.url);
    if (inst && state.instances.has(inst[1])) {
      const i = state.instances.get(inst[1]);
      if (!inst[2]) return send(200, { ID: i.id, ParentSeries: i.series, MainDicomTags: { SOPInstanceUID: i.tags.SOPInstanceUID } });
      if (inst[2] === '/simplified-tags') return send(200, i.tags);
      if (inst[2] === '/frames/0/raw') return i.pixels ? send(200, i.pixels, 'application/octet-stream') : send(404, { Message: 'no frame' });
      return send(200, i.document, 'application/octet-stream');
    }
    const series = /^\/series\/([0-9a-f-]+)$/.exec(req.url);
    if (series) { const i = [...state.instances.values()].find(x => x.series === series[1]);
      if (i) return send(200, { ID: i.series, ParentStudy: i.parent, MainDicomTags: { SeriesInstanceUID: i.tags.SeriesInstanceUID } }); }
    send(404, { Message: 'SYN not found ' + req.url });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  process.env.ORTHANC_URL = 'http://127.0.0.1:' + server.address().port;
  return state;
}

function harness(state) {
  const { StudyAttachmentService } = require('/app/dist/study-attachment.service');
  const { OrthancService } = require('/app/dist/orthanc.service');
  const { parseAccessEvent } = require('/app/dist/emr-contract/access-event');
  const rows = [], audits = [], events = [], studies = new Map([
    [UID, { uid: UID, institutionId: 'inst-a', teleInstitutionId: null, rs: 'W' }],
    [RECEIVED, { uid: RECEIVED, institutionId: 'inst-b', teleInstitutionId: 'inst-a', rs: 'W' }],
    [FOREIGN, { uid: FOREIGN, institutionId: 'inst-b', teleInstitutionId: null, rs: 'W' }],
    [OTHER_UID, { uid: OTHER_UID, institutionId: 'inst-a', teleInstitutionId: null, rs: 'W' }],
  ]);
  const fail = { update: 0, updateMany: 0, audit: 0 };
  const cond = (value, filter) => filter && typeof filter === 'object' && !Array.isArray(filter)
    ? ('not' in filter ? (filter.not === null ? value != null : value !== filter.not) : 'in' in filter ? filter.in.includes(value) : 'lt' in filter ? value < filter.lt : true)
    : value === filter;
  const match = (row, where) => Object.entries(where).every(([key, filter]) => key === 'OR' ? filter.some(w => match(row, w)) : cond(row[key], filter));
  // A transaction works on copies and publishes them only if it ends without an error (as PostgreSQL would).
  let live = rows;
  const table = () => live;
  const prisma = {
    studyState: { findUnique: async ({ where }) => studies.get(where.uid) ?? null },
    studyAttachment: {
      findUnique: async ({ where }) => { const row = where.id ? table().find(r => r.id === where.id)
        : table().find(r => r.createdBySub === where.createdBySub_requestId.createdBySub && r.requestId === where.createdBySub_requestId.requestId);
        return row ? { ...row } : null; },
      findFirst: async ({ where }) => { const row = table().find(r => match(r, where)); return row ? { ...row } : null; },
      findMany: async ({ where, select }) => table().filter(r => match(r, where)).sort((a, b) => b.createdAt - a.createdAt)
        .map(r => select ? Object.fromEntries(Object.keys(select).map(k => [k, r[k] ?? null])) : { ...r }),
      create: async ({ data }) => {
        if (table().some(r => r.createdBySub === data.createdBySub && r.requestId === data.requestId)) throw Object.assign(new Error('unique'), { code: 'P2002' });
        const row = { orthancId: null, objectStudyUid: null, objectSeriesUid: null, objectAt: null, failReason: null, storedAt: null,
          withdrawnAt: null, withdrawnBy: null, withdrawReason: null, createdAt: new Date(), ...data };
        table().push(row); return { ...row };
      },
      update: async ({ where, data }) => {
        if (fail.update > 0) { fail.update--; throw new Error('SYN database failure'); }
        const row = table().find(r => r.id === where.id); Object.assign(row, data); return { ...row };
      },
      updateMany: async ({ where, data }) => {
        if (fail.updateMany > 0) { fail.updateMany--; throw new Error('SYN database failure'); }
        const hit = table().filter(r => match(r, where)); hit.forEach(r => Object.assign(r, data)); return { count: hit.length };
      },
    },
    auditLog: { create: async ({ data }) => {
      if (fail.audit > 0) { fail.audit--; throw new Error('SYN audit failure'); }
      audits.push(data); return { id: audits.length, ...data }; } },
    $executeRaw: async () => 0,
    $queryRaw: async (strings, ...values) => {
      const sql = strings.join('?');
      if (sql.includes('"StudyState"')) { const s = studies.get(values[0]); return s ? [{ institutionId: s.institutionId, rs: s.rs }] : []; }
      if (sql.includes('"StudyAttachment"')) { const r = table().find(x => x.id === values[0]); return r ? [{ state: r.state }] : []; }
      throw new Error('unexpected SQL ' + sql);
    },
  };
  prisma.$transaction = async work => {
    const before = live, copy = live.map(r => ({ ...r })), auditCount = audits.length;
    live = copy;
    try { const out = await work(prisma); before.length = 0; before.push(...copy); return out; }
    catch (error) { audits.length = auditCount; throw error; }
    finally { live = before; }
  };
  const access = { split: false, refused: new Set(), calls: [],
    prepare: async () => {}, require: async (c, uids) => { access.calls.push(uids[0]); if (access.refused.has(uids[0])) throw new Error('outside'); },
    prepareSourceIdentity: async () => {},
    assertUnsplitSource: () => { if (access.split) throw Object.assign(new Error('split'), { getStatus: () => 409 }); return { sourcePatientId: 'P-SYN-1' }; } };
  const record = async (event, effect) => { parseAccessEvent(event); events.push(event); return effect(); };
  const records = { begin: () => ({ transactionWithRecords: async work => prisma.$transaction(tx => work(tx, record)), end() {} }) };
  const service = new StudyAttachmentService(prisma, new OrthancService(), access, records);
  return { service, rows, audits, events, studies, access, fail, prisma, state };
}

const FACTS = c => ({ actor: { id: 'id-' + c.sub, issuer: 'https://kc.synthetic.test/realms/kin', subject: c.sub }, roles: [...c.roles],
  institution: c.institution, ingress: { status: 'known', value: { address: '10.0.0.5', source: 'trusted-proxy' } },
  requestId: randomUUID(), surface: 'POST studies/:uid/attachments', rightsVersion: 1, binding: { method: 'bearer', sessionRef: null } });
function work(h, c, current = async () => {}) { return { facts: FACTS(c), work: h.service['records'].begin(), assertActive() {}, requireCurrent: current }; }
function upload(bytes, type, name, extra = {}) {
  return { headers: { 'content-type': type, 'x-kin-file-name': encodeURIComponent(name), 'x-kin-request-id': randomUUID(), ...extra }, body: bytes };
}
const add = (h, c, req, uid = UID) => h.service.add(uid, req, c, work(h, c));
async function rejects(promise, status, message) {
  await assert.rejects(promise, error => {
    assert.equal(error.getStatus?.(), status, `${error.message}`);
    if (message !== undefined) assert.equal(error.message, message);
    return true;
  });
}

/** The DICOMweb gate over this harness's rows, with the synthetic Orthanc for Orthanc-ID paths. */
function gate(h) {
  const { PacsDicomGateway } = require('/app/dist/pacs/dicom-gateway');
  const { OrthancService } = require('/app/dist/orthanc.service');
  const orthancService = new OrthancService();
  orthancService.instanceStudyUid = async id => h.state.instances.get(id)?.tags.StudyInstanceUID ?? UID;
  orthancService.lookupInstance = async sop => [...h.state.instances.values()].filter(i => i.tags.SOPInstanceUID === sop).map(i => ({ Type: 'Instance', ID: i.id }));
  return new PacsDicomGateway(h.prisma, orthancService, h.access, { visible: (s, me) => s.institutionId === me || s.teleInstitutionId === me }, {});
}

test('FC-076 pure rules: kind from the first bytes, file name, picture size, one new UID each time', () => {
  const m = require('/app/dist/study-attachment');
  assert.equal(m.sniffAttachment(png(4, 3)), 'png');
  assert.equal(m.sniffAttachment(jpeg(4, 3)), 'jpeg');
  assert.equal(m.sniffAttachment(PDF), 'pdf');
  assert.equal(m.sniffAttachment(Buffer.from('GIF89a')), null);
  assert.equal(m.sniffAttachment(Buffer.alloc(0)), null);
  assert.deepEqual(m.imageSize(png(640, 480), 'png'), { columns: 640, rows: 480 });
  assert.deepEqual(m.imageSize(jpeg(1024, 768), 'jpeg'), { columns: 1024, rows: 768 });
  assert.equal(m.imageSize(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'jpeg'), null);
  assert.equal(m.decodeFileName(encodeURIComponent('동의서 스캔.pdf')), '동의서 스캔.pdf');
  assert.equal(m.decodeFileName(encodeURIComponent('C:\\scans\\page1.png')), 'page1.png');
  for (const bad of [undefined, '', '%E0%A4%A', encodeURIComponent('a\nb.pdf'), encodeURIComponent('x'.repeat(256)), 'raw name.pdf'])
    assert.equal(m.decodeFileName(bad), null, String(bad));
  const one = m.newDicomUid(), two = m.newDicomUid();
  assert.match(one, /^2\.25\.\d+$/); assert.ok(one.length <= 64); assert.notEqual(one, two);
});

test('FC-076 the body parser: one raw file up to 20 MB on the exact attach route, the rest untouched', async t => {
  const { studyAttachmentParser } = require('/app/dist/study-attachment-parser');
  const parser = studyAttachmentParser();
  const server = http.createServer((req, res) => { req.originalUrl = req.url; parser(req, res, () => {
    res.end(JSON.stringify({ error: req.attachmentError ?? null, bytes: Buffer.isBuffer(req.body) ? req.body.length : null })); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const send = (path, size, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method: 'POST', headers: { 'Content-Type': 'application/pdf', ...headers } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString()))); });
    req.on('error', reject); req.end(Buffer.alloc(size, 0x25));
  });
  assert.deepEqual(await send(`/api/studies/${UID}/attachments`, 20 * 1024 * 1024), { error: null, bytes: 20 * 1024 * 1024 });
  assert.deepEqual(await send(`/api/studies/${UID}/attachments`, 20 * 1024 * 1024 + 1), { error: 413, bytes: 0 });
  assert.deepEqual(await send(`/api/studies/${UID}/attachments`, 10, { 'Content-Encoding': 'gzip' }), { error: 415, bytes: 0 });
  assert.deepEqual(await send(`/api/studies/${UID}/attachments/x/withdraw`, 10), { error: null, bytes: null });
});

test('FC-076 attach a picture: Parent is the Orthanc study ID, one new series per file, read back, then audit and access record', async t => {
  const state = await orthanc(t), h = harness(state);
  const first = await add(h, TECH, upload(png(640, 480), 'image/png', '동의서.png'));
  const second = await add(h, RAD, upload(jpeg(800, 600), 'image/jpeg', 'scan.jpg'));
  assert.equal(first.state, 'stored'); assert.equal(second.state, 'stored');
  assert.deepEqual(Object.keys(first).sort(), ['bytes', 'createdAt', 'createdBy', 'failReason', 'fileName', 'id', 'kind', 'state',
    'withdrawReason', 'withdrawnAt', 'withdrawnBy']);
  assert.equal(first.fileName, '동의서.png');
  assert.equal(state.creates.length, 2);
  for (const body of state.creates) {
    assert.equal(body.Parent, STUDY_ID);   // the Orthanc study ID, never the StudyInstanceUID
    assert.equal(body.Force, true);
    assert.equal(body.Tags.SOPClassUID, '1.2.840.10008.5.1.4.1.1.7');
    assert.equal(body.Tags.SeriesDescription, 'Attached Document');
    for (const tag of ['PatientID', 'PatientName', 'StudyInstanceUID', 'PatientBirthDate']) assert.ok(!(tag in body.Tags), tag);
  }
  assert.notEqual(state.creates[0].Tags.SeriesInstanceUID, state.creates[1].Tags.SeriesInstanceUID);
  assert.deepEqual(h.rows.map(r => r.seriesInstanceUid), state.creates.map(b => b.Tags.SeriesInstanceUID));
  assert.ok(state.requests.some(r => r.url === '/tools/lookup' && r.contentType === 'text/plain' && r.raw === UID));
  assert.deepEqual(h.audits.map(a => [a.action, a.target]), [['study.attachment.add', UID], ['study.attachment.add', UID]]);
  const detail = JSON.parse(h.audits[0].detail);
  assert.deepEqual(Object.keys(detail).sort(), ['bytes', 'institution', 'kind', 'sop']);   // no file name
  assert.equal(detail.sop, h.rows[0].sopInstanceUid);
  assert.equal(h.events.length, 2);
  assert.equal(h.events[0].surface, 'POST studies/:uid/attachments');
  assert.equal(h.events[0].targets[0].kind, 'image');
  assert.equal(h.events[0].targets[0].recordId.value, h.rows[0].sopInstanceUid);
  assert.equal(h.events[0].targets[0].patientLinkSnapshot.value.patientId, 'P-SYN-1');
  assert.equal(h.events[0].userId.value.subject, 'sub-tech');
});

test('FC-076 attach a PDF: Encapsulated PDF, its stored document checked against the uploaded bytes (DICOM padding aside)', async t => {
  const state = await orthanc(t), h = harness(state);
  const answer = await add(h, TECH, upload(PDF, 'application/pdf', 'referral.pdf'));
  assert.equal(answer.state, 'stored'); assert.equal(answer.kind, 'pdf');
  assert.equal(state.creates[0].Tags.SOPClassUID, '1.2.840.10008.5.1.4.1.1.104.1');
  assert.match(state.creates[0].Content, /^data:application\/pdf;base64,/);
  assert.equal(h.events[0].targets[0].kind, 'pdf');
});

test('FC-076 refusals: format, declared type, size, role, institution, received study, StudyAccess, split UID', async t => {
  const state = await orthanc(t), h = harness(state);
  await rejects(add(h, TECH, upload(Buffer.from('GIF89a....'), 'image/png', 'a.png')), 415, 'JPG·PNG·PDF 파일만 붙일 수 있습니다');
  await rejects(add(h, TECH, upload(PDF, 'image/png', 'a.png')), 415, 'JPG·PNG·PDF 파일만 붙일 수 있습니다');
  await rejects(add(h, TECH, upload(Buffer.alloc(0), 'application/pdf', 'a.pdf')), 415);
  await rejects(add(h, TECH, { ...upload(PDF, 'application/pdf', 'a.pdf'), attachmentError: 413 }), 413, '파일이 20MB를 넘습니다');
  await rejects(add(h, TECH, upload(PDF, 'application/pdf', 'a.pdf', { 'x-kin-request-id': 'nope' })), 400);
  await rejects(add(h, TECH, upload(PDF, 'application/pdf', 'a.pdf', { 'x-kin-file-name': '' })), 400);
  await rejects(add(h, CLIN, upload(PDF, 'application/pdf', 'a.pdf')), 403);
  await rejects(add(h, GATEWAY, upload(PDF, 'application/pdf', 'a.pdf')), 403);
  await rejects(add(h, OTHER, upload(PDF, 'application/pdf', 'a.pdf')), 404, '검사를 찾을 수 없습니다');
  await rejects(add(h, TECH, upload(PDF, 'application/pdf', 'a.pdf'), FOREIGN), 404);
  await rejects(add(h, TECH, upload(PDF, 'application/pdf', 'a.pdf'), RECEIVED), 403, '원격판독으로 받은 검사에는 문서를 붙이거나 철회할 수 없습니다');
  h.access.refused.add(UID);
  await rejects(add(h, TECH, upload(PDF, 'application/pdf', 'a.pdf')), 404);
  h.access.refused.clear(); h.access.split = true;
  await rejects(add(h, TECH, upload(PDF, 'application/pdf', 'a.pdf')), 409);
  h.access.split = false; h.studies.get(UID).rs = 'D';
  await rejects(add(h, TECH, upload(PDF, 'application/pdf', 'a.pdf')), 410);
  assert.equal(state.creates.length, 0); assert.equal(h.rows.length, 0); assert.equal(h.events.length, 0);
  // admin passes as with need(); the same file then attaches.
  h.studies.get(UID).rs = 'W';
  assert.equal((await add(h, ADMIN, upload(PDF, 'application/pdf', 'a.pdf'))).state, 'stored');
});

test('FC-076 read-back mismatch: the object is failed, kept out of serving and never stored or recorded as an entry', async t => {
  const state = await orthanc(t), h = harness(state);
  state.mode = 'wrongPatient';
  const answer = await add(h, TECH, upload(png(10, 10), 'image/png', 'x.png'));
  assert.equal(answer.state, 'failed'); assert.equal(answer.failReason, '환자 식별이 원본 검사와 다릅니다');
  assert.ok(h.rows[0].orthancId);
  assert.deepEqual(h.audits.map(a => a.action), ['study.attachment.mismatch']);
  assert.equal(h.events.length, 0);
  const { hiddenAttachments } = require('/app/dist/study-attachment');
  const hidden = await hiddenAttachments(h.prisma, UID);
  assert.ok(hidden.series.has(h.rows[0].seriesInstanceUid) && hidden.orthancIds.has(h.rows[0].orthancId));
});

test('FC-076 Orthanc refused the write: failed, nothing stored', async t => {
  const state = await orthanc(t), h = harness(state);
  state.mode = 'refuse';
  const answer = await add(h, TECH, upload(PDF, 'application/pdf', 'x.pdf'));
  assert.equal(answer.state, 'failed'); assert.equal(answer.failReason, '문서가 저장되지 않았습니다');
  assert.equal(h.audits.length, 0); assert.equal(h.events.length, 0);
});

test('FC-076 a lost Orthanc answer is recovered by the planned SOP UID; a repeated request id answers the same row', async t => {
  const state = await orthanc(t), h = harness(state);
  state.mode = 'lost';
  const req = upload(png(32, 16), 'image/png', 'lost.png');
  const answer = await add(h, TECH, req);
  assert.equal(answer.state, 'stored');
  assert.equal(state.creates.length, 1);
  assert.ok(state.requests.some(r => r.url === '/tools/lookup' && r.raw === h.rows[0].sopInstanceUid));
  // The browser sends the same request again: no second object, the same answer.
  state.mode = 'ok';
  const again = await add(h, TECH, { ...req, headers: { ...req.headers } });
  assert.equal(again.id, answer.id); assert.equal(state.creates.length, 1); assert.equal(h.audits.length, 1);
  // The same request id for another file is refused.
  await rejects(add(h, TECH, { headers: { ...req.headers }, body: png(33, 16) }), 409, '이 요청 번호는 다른 파일이나 다른 검사에 이미 쓰였습니다');
});

test('FC-076 a database failure after the Orthanc write leaves the row pending; recovery stores it once', async t => {
  const state = await orthanc(t), h = harness(state);
  h.fail.update = 1;
  await rejects(add(h, TECH, upload(PDF, 'application/pdf', 'db.pdf')), 503,
    '저장 결과를 아직 확인하지 못했습니다. 이 검사에 붙은 문서 목록에서 다시 확인됩니다');
  assert.equal(h.rows[0].state, 'pending'); assert.equal(state.instances.size, 1); assert.equal(h.events.length, 0);
  const { hiddenAttachments } = require('/app/dist/study-attachment');
  assert.ok((await hiddenAttachments(h.prisma, UID)).series.has(h.rows[0].seriesInstanceUid));   // not served while unconfirmed
  h.rows[0].createdAt = new Date(Date.now() - 60000);
  await h.service['recoverPending']();
  assert.equal(h.rows[0].state, 'stored'); assert.equal(state.creates.length, 1);
  assert.deepEqual(h.audits.map(a => a.action), ['study.attachment.add']);
  assert.equal(h.events.length, 1); assert.equal(h.events[0].userId.value.subject, 'sub-tech');
  assert.equal((await hiddenAttachments(h.prisma, UID)).series.size, 0);
});

test('FC-076 a pending row with nothing in Orthanc after the wait becomes failed', async t => {
  const state = await orthanc(t), h = harness(state);
  state.mode = 'void';
  await rejects(add(h, TECH, upload(PDF, 'application/pdf', 'gone.pdf')), 503);
  assert.equal(h.rows[0].state, 'pending');
  h.rows[0].createdAt = new Date(Date.now() - 180000);
  await h.service['recoverPending']();
  assert.equal(h.rows[0].state, 'failed'); assert.equal(h.events.length, 0);
});

test('FC-076 list: the study\'s attachments, newest first, Withdrawn shown; who may attach and withdraw', async t => {
  const state = await orthanc(t), h = harness(state);
  await add(h, TECH, upload(PDF, 'application/pdf', 'a.pdf'));
  await new Promise(r => setTimeout(r, 5));
  const second = await add(h, TECH, upload(png(2, 2), 'image/png', 'b.png'));
  await h.service.withdraw(UID, second.id, { reason: '다른 환자 문서' }, TECH, work(h, TECH));
  const list = await h.service.list(UID, RAD);
  assert.deepEqual(list.attachments.map(a => [a.fileName, a.state]), [['b.png', 'withdrawn'], ['a.pdf', 'stored']]);
  assert.equal(list.attachments[0].withdrawReason, '다른 환자 문서');
  assert.equal(list.canAttach, true); assert.equal(list.canWithdraw, false);
  assert.equal((await h.service.list(UID, TECH)).canWithdraw, true);
  const received = await h.service.list(RECEIVED, RAD);
  assert.equal(received.canAttach, false);
  await rejects(h.service.list(UID, CLIN), 403);
  await rejects(h.service.list(UID, OTHER), 404);
});

test('FC-076 withdraw: technician or admin, reason required, only this feature\'s objects, recorded, idempotent', async t => {
  const state = await orthanc(t), h = harness(state);
  const att = await add(h, TECH, upload(PDF, 'application/pdf', 'w.pdf'));
  await rejects(h.service.withdraw(UID, att.id, { reason: '   ' }, TECH, work(h, TECH)), 400, '사유가 필요합니다');
  await rejects(h.service.withdraw(UID, att.id, {}, TECH, work(h, TECH)), 400, '사유가 필요합니다');
  await rejects(h.service.withdraw(UID, att.id, { reason: 'x' }, RAD, work(h, RAD)), 403);
  await rejects(h.service.withdraw(UID, att.id, { reason: 'x' }, OTHER, work(h, OTHER)), 404);
  await rejects(h.service.withdraw(UID, randomUUID(), { reason: 'x' }, TECH, work(h, TECH)), 404, '붙은 문서를 찾을 수 없습니다');
  await rejects(h.service.withdraw(RECEIVED, att.id, { reason: 'x' }, TECH, work(h, TECH)), 403);
  const done = await h.service.withdraw(UID, att.id, { reason: '잘못 붙임' }, ADMIN, work(h, ADMIN));
  assert.equal(done.state, 'withdrawn'); assert.equal(done.withdrawnBy, 'SYN-admin'); assert.ok(done.withdrawnAt);
  assert.deepEqual(h.audits.map(a => a.action), ['study.attachment.add', 'study.attachment.withdraw']);
  assert.deepEqual(Object.keys(JSON.parse(h.audits[1].detail)).sort(), ['institution', 'kind', 'sop']);
  assert.equal(h.events[1].surface, 'POST studies/:uid/attachments/:id/withdraw');
  assert.equal(h.events[1].action, 'cancel');
  assert.equal(state.instances.size, 1);   // the original stays in the archive
  const again = await h.service.withdraw(UID, att.id, { reason: '두 번째' }, TECH, work(h, TECH));
  assert.equal(again.withdrawReason, '잘못 붙임'); assert.equal(h.events.length, 2);
  // A failed (never stored) attachment is not withdrawn.
  state.mode = 'refuse';
  const failed = await add(h, TECH, upload(PDF, 'application/pdf', 'f.pdf'));
  await rejects(h.service.withdraw(UID, failed.id, { reason: 'x' }, TECH, work(h, TECH)), 409, '저장이 확인된 문서만 철회할 수 있습니다');
});

test('FC-076 after withdrawal the serving paths leave it out: DICOMweb gate, SOP lookup, metadata and series lists, download manifest', async t => {
  const state = await orthanc(t), h = harness(state);
  const kept = await add(h, TECH, upload(PDF, 'application/pdf', 'keep.pdf'));
  const gone = await add(h, TECH, upload(png(4, 4), 'image/png', 'gone.png'));
  await h.service.withdraw(UID, gone.id, { reason: '잘못 붙임' }, TECH, work(h, TECH));
  const row = h.rows.find(r => r.id === gone.id), keep = h.rows.find(r => r.id === kept.id);

  // The DICOMweb gate (authz/dicom and every relayed or range-read image path).
  const gateway = gate(h);
  const refused = async path => rejects(gateway.authzDicom(path, 'GET', RAD), 403);
  await refused(`/dicom-web/studies/${UID}/series/${row.seriesInstanceUid}/metadata`);
  await refused(`/dicom-web/studies/${UID}/series/${row.seriesInstanceUid}/instances/${row.sopInstanceUid}/frames/1`);
  await refused(`/dicom-web/studies/${UID}/series/${row.seriesInstanceUid}/instances/${row.sopInstanceUid}/rendered`);
  await refused(`/instances/${row.orthancId}/preview`);
  await refused(`/instances/${row.orthancId}/file`);
  // The whole study at once would carry it along: refused while the study has a left-out attachment.
  await refused(`/dicom-web/studies/${UID}`);
  await refused(`/dicom-web/studies/${UID}/rendered`);
  await refused(`/dicom-web/studies/${UID}/thumbnail`);
  await rejects(gateway.dicomLookup(UID, row.sopInstanceUid, RAD), 403);
  const admitted = await gateway.authzDicom(`/dicom-web/studies/${UID}/series`, 'GET', RAD);
  assert.ok(await gateway.authzDicom(`/dicom-web/studies/${UID}/series/${keep.seriesInstanceUid}/metadata`, 'GET', RAD));
  assert.ok(await gateway.authzDicom(`/instances/${keep.orthancId}/content/0042-0011`, 'GET', RAD));

  // The metadata relay: QIDO series and study metadata without the withdrawn series; others unchanged byte for byte.
  const { DicomwebReadRecorder } = require('/app/dist/emr-viewing/dicomweb-read');
  const recorder = new DicomwebReadRecorder(h.prisma, {}, {});
  recorder.record = async () => null;
  const series = s => ({ '0020000E': { vr: 'UI', Value: [s] }, '0020000D': { vr: 'UI', Value: [UID] } });
  const relay = async (answer, study) => {
    const out = { status: 0, headers: {}, body: null };
    const res = { status(c) { out.status = c; }, setHeader(n, v) { out.headers[n.toLowerCase()] = v; }, end(b) { out.body = b; } };
    const orthancStub = { relay: async (uri, accept, target) => { target.status(200); target.setHeader('Content-Type', 'application/dicom+json');
      target.setHeader('Content-Length', String(Buffer.byteLength(answer))); target.write(Buffer.from(answer)); target.end(); } };
    await recorder.relay({ method: 'GET', headers: {} }, res, orthancStub, '/dicom-web/studies/' + UID + '/series', 'https://x', study, new AbortController().signal);
    return out;
  };
  const both = JSON.stringify([series(keep.seriesInstanceUid), series(row.seriesInstanceUid), series('1.2.3.4')]);
  const filtered = await relay(both, admitted);
  assert.deepEqual(JSON.parse(filtered.body.toString()).map(s => s['0020000E'].Value[0]), [keep.seriesInstanceUid, '1.2.3.4']);
  assert.equal(filtered.headers['content-length'], undefined);
  const untouched = JSON.stringify([series('1.2.3.4')]) + '  ';
  assert.equal((await relay(untouched, admitted)).body.toString(), untouched);

  // The original download manifest.
  const { StudyTransferLocalService } = require('/app/dist/study-transfer-local.service');
  const transfer = Object.create(StudyTransferLocalService.prototype);
  transfer.prisma = h.prisma;
  const ids = ['11111111-11111111-11111111-11111111-11111111', keep.orthancId, row.orthancId];
  transfer.gate = { studyInstanceIds: async () => ids,
    instanceUids: async id => ({ studyUid: UID, sourcePatientId: 'P-SYN-1', ...(id === ids[0] ? { seriesUid: '1.2.3.4', sopUid: '1.2.3.4.5' }
      : { seriesUid: state.instances.get(id).tags.SeriesInstanceUID, sopUid: state.instances.get(id).tags.SOPInstanceUID }) }),
    attachmentInfo: async () => ({ bytes: 10, md5: 'a'.repeat(32) }) };
  const read = await transfer.readOriginals(UID);
  assert.deepEqual(read.objects.map(o => o.orthancId), [ids[0], keep.orthancId]);
});

test('FC-076 a picture is checked by its pixels: a PNG decoded here (RGB, RGBA without alpha, every filter) must be what Orthanc stored', async t => {
  const state = await orthanc(t), h = harness(state);
  const rgba = png(7, 5, { color: 6, filters: [0, 1, 2, 3, 4] }), grey = png(6, 3, { color: 0, filters: [4, 3] });
  assert.equal((await add(h, TECH, upload(rgba, 'image/png', 'rgba.png'))).state, 'stored');
  assert.equal((await add(h, TECH, upload(grey, 'image/png', 'grey.png'))).state, 'stored');
  const { pngPixels } = require('/app/dist/study-attachment');
  assert.deepEqual(pngPixels(rgba).pixels, PIXELS.get(rgba.toString('base64')).pixels, 'RGBA decodes to RGB, every filter type');
  assert.equal(h.rows[0].access.expect.pixels.samples, 3);
  assert.equal(h.rows[1].access.expect.pixels.samples, 1);
  // The same size with other pixels is not the uploaded picture.
  state.mode = 'wrongPixels';
  const wrong = await add(h, TECH, upload(png(7, 5, { filters: [2] }), 'image/png', 'wrong.png'));
  assert.equal(wrong.state, 'failed'); assert.equal(wrong.failReason, '실린 그림의 화소가 올린 파일과 다릅니다');
  // A PNG this server cannot decode is refused before anything is written.
  await rejects(add(h, TECH, upload(png(2, 2, { depth: 16 }), 'image/png', 'deep.png')), 415, '그림 파일을 읽을 수 없습니다');
  assert.equal(state.creates.length, 3);
});

test('FC-076 the account rights are read again before the archive write: a refused account writes nothing', async t => {
  const state = await orthanc(t), h = harness(state);
  const { ForbiddenException } = require('/app/node_modules/@nestjs/common');
  const ended = async () => { throw new ForbiddenException('세션이 끝났습니다'); };
  await rejects(h.service.add(UID, upload(PDF, 'application/pdf', 'late.pdf'), TECH, work(h, TECH, ended)), 403);
  assert.deepEqual([state.creates.length, h.rows.length], [0, 0]);
});

test('FC-076 a mismatch is failed with its audit row once; a failed audit leaves it pending for recovery', async t => {
  const state = await orthanc(t), h = harness(state);
  state.mode = 'wrongPatient';
  h.fail.audit = 1;
  await rejects(add(h, TECH, upload(PDF, 'application/pdf', 'x.pdf')), 503);
  assert.equal(h.rows[0].state, 'pending'); assert.deepEqual(h.audits, []);
  h.rows[0].createdAt = new Date(Date.now() - 60000);
  await h.service['recoverPending']();
  await h.service['recoverPending']();
  assert.equal(h.rows[0].state, 'failed');
  assert.deepEqual(h.audits.map(a => a.action), ['study.attachment.mismatch']);
});

test('FC-076 an object the rows do not name yet (lost answer, database down) is refused by its own UIDs; one stored elsewhere is hidden there', async t => {
  const state = await orthanc(t), h = harness(state);
  // Orthanc wrote it, the answer was lost, and the database could note neither the sighting nor the store.
  state.mode = 'lost'; h.fail.updateMany = 1;
  await rejects(add(h, TECH, upload(PDF, 'application/pdf', 'lost.pdf')), 503);
  const row = h.rows[0], object = [...state.instances.values()][0];
  assert.equal(row.orthancId, null);
  const g = gate(h);
  await rejects(g.authzDicom(`/instances/${object.id}/pdf`, 'GET', RAD), 403);
  await rejects(g.authzDicom(`/instances/${object.id}/file`, 'GET', RAD), 403);
  // Written under another study and series than planned: failed, and left out under the study and series Orthanc holds.
  state.mode = 'otherParent';
  const elsewhere = await add(h, TECH, upload(png(3, 3), 'image/png', 'elsewhere.png'));
  assert.equal(elsewhere.state, 'failed'); assert.equal(elsewhere.failReason, '다른 검사 아래에 만들어졌습니다');
  const stored = h.rows.find(r => r.id === elsewhere.id);
  assert.deepEqual([stored.objectStudyUid, stored.objectSeriesUid], [OTHER_UID, OTHER_SERIES]);
  const { hiddenAttachments, withoutHidden } = require('/app/dist/study-attachment');
  const there = await hiddenAttachments(h.prisma, OTHER_UID);
  assert.ok(there.series.has(OTHER_SERIES));
  await rejects(g.authzDicom(`/dicom-web/studies/${OTHER_UID}/series/${OTHER_SERIES}/metadata`, 'GET', RAD), 403);
  const series = s => ({ '0020000E': { vr: 'UI', Value: [s] } });
  assert.deepEqual(withoutHidden([series(OTHER_SERIES), series('1.2.3')], there), [series('1.2.3')]);
});

test('FC-076 a study without left-out attachments keeps its whole-study reads', async t => {
  const state = await orthanc(t), h = harness(state);
  await add(h, TECH, upload(PDF, 'application/pdf', 'kept.pdf'));
  const g = gate(h);
  assert.ok(await g.authzDicom(`/dicom-web/studies/${UID}`, 'GET', RAD));
  assert.ok(await g.authzDicom(`/dicom-web/studies/${UID}/series`, 'GET', RAD));
});
test('FC-076 an object stored under another study stays left out there even when its mismatch audit fails', async t => {
  const state = await orthanc(t), h = harness(state);
  state.mode = 'otherParent'; h.fail.audit = 1;
  await rejects(add(h, TECH, upload(PDF, 'application/pdf', 'elsewhere.pdf')), 503);
  const row = h.rows[0], object = [...state.instances.values()][0];
  assert.equal(row.state, 'pending');
  assert.deepEqual([row.orthancId, row.objectStudyUid, row.objectSeriesUid], [object.id, OTHER_UID, OTHER_SERIES]);
  const g = gate(h), refused = path => rejects(g.authzDicom(path, 'GET', RAD), 403);
  await refused(`/instances/${object.id}/pdf`);
  await refused(`/dicom-web/studies/${OTHER_UID}`);
  await refused(`/dicom-web/studies/${OTHER_UID}/series/${OTHER_SERIES}/instances/${row.sopInstanceUid}`);
  await rejects(g.dicomLookup(OTHER_UID, row.sopInstanceUid, RAD), 403);
  row.createdAt = new Date(Date.now() - 60000);
  await h.service['recoverPending']();
  assert.equal(h.rows[0].state, 'failed');
  assert.deepEqual(h.audits.map(a => a.action), ['study.attachment.mismatch']);
  await refused(`/instances/${object.id}/pdf`);
});