'use strict';
/* Film / DICOM Print: the API's layout, print jobs and their output record against a synthetic Orthanc on 127.0.0.1
 * (study lookup, series and instances, header Window Center/Width as `/content/0028-1050`, frames rendered as PAM with
 * the query recorded), an in-memory database and the worklist's targeted read. The DICOM helper is a stand-in Python
 * script (stdlib only) that records the request it was given and answers scripted lines; the real helper is covered by
 * tests/film_print_helper_test.py against synthetic printers. No DB, credentials or external network.
 */
require('./service_test_loader.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

process.env.ORTHANC_USER = process.env.ORTHANC_USER || 'SYN';
process.env.ORTHANC_PASS = process.env.ORTHANC_PASS || 'SYN';

const STUDY = '1.2.826.0.1.3680043.8.498.81';
const OID = n => `${String(n).padStart(8, '0')}-00000000-00000000-00000000-00000000`;
const STUDY_ID = OID(1);
const RAD = { sub: 'sub-rad', actor: 'SYN-rad', roles: ['radiologist'], institution: 'inst-a', kind: 'member' };
const TECH = { sub: 'sub-tech', actor: 'SYN-tech', roles: ['technician'], institution: 'inst-a', kind: 'member' };
const OTHER = { sub: 'sub-other', actor: 'SYN-other', roles: ['radiologist'], institution: 'inst-b', kind: 'member' };
const CLIN = { sub: 'sub-clin', actor: 'SYN-clin', roles: ['clinician'], institution: 'inst-a', kind: 'member' };

// The study: CT (series 2: six single-frame images and one image of three frames, numbered out of order), a scout
// (series 1, one image), an SR and an attached document (left out).
const SERIES = {
  scout: { id: OID(10), uid: STUDY + '.1', number: '1', description: 'SYN scout', modality: 'CT', instances: [OID(101)] },
  ct: { id: OID(20), uid: STUDY + '.2', number: '2', description: 'SYN axial', modality: 'CT',
    instances: [OID(201), OID(202), OID(203), OID(204), OID(205), OID(206), OID(207)] },
  sr: { id: OID(30), uid: STUDY + '.3', number: '3', description: 'SYN SR', modality: 'SR', instances: [OID(301)] },
  doc: { id: OID(40), uid: STUDY + '.4', number: '4', description: 'SYN attached', modality: 'OT', instances: [OID(401)] },
};
// InstanceNumber per instance (201 is #7, 207 has three frames and is #3), and which ones carry a window.
const NUMBER = { [OID(201)]: '7', [OID(202)]: '1', [OID(203)]: '2', [OID(204)]: '4', [OID(205)]: '5', [OID(206)]: '6', [OID(207)]: '3', [OID(101)]: '1' };
const WINDOW = { [OID(202)]: ['40\\400', '80\\1500'], [OID(207)]: ['-600', '1500'] };

function pam(width, height, value, depth = 1) {
  const head = Buffer.from(`P7\nWIDTH ${width}\nHEIGHT ${height}\nDEPTH ${depth}\nMAXVAL 255\nTUPLTYPE ${depth === 1 ? 'GRAYSCALE' : 'RGB'}\nENDHDR\n`, 'latin1');
  return Buffer.concat([head, Buffer.alloc(width * height * depth, value)]);
}

async function orthanc(t) {
  const state = { requests: [], rendered: [], extra: [] };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    state.requests.push({ method: req.method, url: req.url });
    const send = (status, value, type = 'application/json') => {
      const body = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
      res.writeHead(status, { 'Content-Type': type, 'Content-Length': body.length }); res.end(body);
    };
    if (req.url === '/system') return send(200, { DicomAet: 'KINLAB' });
    if (req.url === '/tools/lookup' && req.method === 'POST') return send(200, raw === STUDY ? [{ Type: 'Study', ID: STUDY_ID }] : []);
    if (req.url === `/studies/${STUDY_ID}`) return send(200, { ID: STUDY_ID,
      MainDicomTags: { StudyInstanceUID: STUDY, StudyDate: '20261101', StudyTime: '101500', AccessionNumber: 'SYNACC81', StudyID: 'S81', StudyDescription: 'SYN CT' },
      PatientMainDicomTags: { PatientName: 'SYN^FILM', PatientID: 'SYN-81', PatientBirthDate: '19700101', PatientSex: 'O' } });
    if (req.url === `/studies/${STUDY_ID}/series`) return send(200, Object.values(SERIES).map(s => ({ ID: s.id,
      MainDicomTags: { SeriesInstanceUID: s.uid, SeriesNumber: s.number, SeriesDescription: s.description, Modality: s.modality }, Instances: s.instances })));
    const series = /^\/series\/([^/]+)\/instances$/.exec(req.url);
    if (series) {
      const s = Object.values(SERIES).find(x => x.id === series[1]);
      return send(200, [...s.instances, ...(s === SERIES.ct ? state.extra : [])].map(id => ({ ID: id, MainDicomTags: { SOPInstanceUID: `${s.uid}.${parseInt(id, 10)}`, InstanceNumber: NUMBER[id] ?? '1',
        ...(id === OID(207) ? { NumberOfFrames: '3' } : {}) } })));
    }
    const content = /^\/instances\/([^/]+)\/content\/0028-105([01])$/.exec(req.url);
    if (content) {
      const w = WINDOW[content[1]];
      return w ? send(200, w[content[2] === '0' ? 0 : 1], 'text/plain') : send(404, { Message: 'Inexistent tag' });
    }
    const rendered = /^\/instances\/([^/]+)\/frames\/(\d+)\/rendered\?(.*)$/.exec(req.url);
    if (rendered) {
      state.rendered.push({ instance: rendered[1], frame: Number(rendered[2]), query: rendered[3], accept: req.headers.accept });
      // A picture whose grey value names its instance and frame (10 x 8, smaller than any cell).
      return send(200, pam(10, 8, (parseInt(rendered[1], 10) % 100) * 10 + Number(rendered[2])), 'image/x-portable-arbitrarymap');
    }
    send(404, { Message: 'SYN not found ' + req.url });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  process.env.ORTHANC_URL = 'http://127.0.0.1:' + server.address().port;
  return state;
}

/** The stand-in helper: records its request (pixel data as length and sum) and answers the scripted lines. */
const HELPER = `import json, os, sys, time, base64
req = json.loads(sys.stdin.read())
def px(b): d = base64.b64decode(b['pixels']); return {'width': b['width'], 'height': b['height'], 'length': len(d), 'sum': sum(d)}
rec = {k: v for k, v in req.items() if k not in ('boxes', 'image')}
if 'boxes' in req: rec['boxes'] = [dict(position=b['position'], **px(b)) for b in req['boxes']]
if 'image' in req: rec['image'] = px(req['image'])
with open(os.environ['SYN_HELPER_OUT'], 'a') as out: out.write(json.dumps(rec) + '\\n')
for line in json.loads(os.environ.get('SYN_HELPER_LINES', '[]')):
    if 'sleep' in line: time.sleep(line['sleep']); continue
    sys.stdout.write(json.dumps(line) + '\\n'); sys.stdout.flush()
`;

function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syn-film-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'helper.py'), HELPER);
  process.env.KIN_FILM_PRINT_PYTHON = process.platform === 'win32' ? 'python' : 'python3';
  process.env.KIN_FILM_PRINT_HELPER = path.join(dir, 'helper.py');
  process.env.SYN_HELPER_OUT = path.join(dir, 'requests.jsonl');
  const lines = value => { process.env.SYN_HELPER_LINES = JSON.stringify(value); };
  lines([{ event: 'sent', printJobUid: '1.2.3.4' }, { event: 'final', state: 'printed', warnings: [] }]);
  const requests = () => fs.existsSync(process.env.SYN_HELPER_OUT)
    ? fs.readFileSync(process.env.SYN_HELPER_OUT, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];

  const { FilmPrintService } = require('/app/dist/film-print.service');
  const { OrthancService } = require('/app/dist/orthanc.service');
  const peers = [
    { id: randomUUID(), institutionId: 'inst-a', name: 'SYN Printer A', aet: 'SYNPRA', host: '127.0.0.1', port: 11112, kind: 'printer', filmSizes: '' },
    { id: randomUUID(), institutionId: 'inst-a', name: 'SYN Printer B', aet: 'SYNPRB', host: '127.0.0.1', port: 11113, kind: 'printer', filmSizes: '14INX17IN' },
    { id: randomUUID(), institutionId: 'inst-a', name: 'SYN Workstation', aet: 'SYNWS', host: '127.0.0.1', port: 11114, kind: 'store', filmSizes: '' },
    { id: randomUUID(), institutionId: 'inst-b', name: 'SYN Other Printer', aet: 'SYNPRO', host: '127.0.0.1', port: 11115, kind: 'printer', filmSizes: '' },
  ];
  const jobs = [], audits = [], listCalls = [];
  const match = (row, where) => Object.entries(where).every(([k, v]) => v && typeof v === 'object' && Array.isArray(v.in) ? v.in.includes(row[k]) : row[k] === v);
  const prisma = {
    dicomPeer: {
      findMany: async ({ where }) => peers.filter(p => match(p, where)).sort((a, b) => a.name.localeCompare(b.name)).map(p => ({ ...p })),
      findFirst: async ({ where }) => { const p = peers.find(x => match(x, where)); return p ? { ...p } : null; },
    },
    studyAttachment: { findMany: async ({ where }) => where.uid === STUDY ? [{ seriesInstanceUid: SERIES.doc.uid }] : [] },
    filmPrintJob: {
      findUnique: async ({ where }) => { const k = where.createdBySub_requestId; const r = jobs.find(j => j.createdBySub === k.createdBySub && j.requestId === k.requestId); return r ? structuredClone(r) : null; },
      findFirst: async ({ where }) => { const r = jobs.find(j => match(j, where)); return r ? structuredClone(r) : null; },
      findMany: async ({ where }) => jobs.filter(j => match(j, where)).map(j => structuredClone(j)),
      create: async ({ data }) => {
        if (jobs.some(j => j.createdBySub === data.createdBySub && j.requestId === data.requestId)) throw Object.assign(new Error('unique'), { code: 'P2002' });
        const row = { id: randomUUID(), createdAt: new Date(), endedAt: null, reason: null, printJobUid: null, ...structuredClone(data) };
        jobs.push(row); return structuredClone(row);
      },
      updateMany: async ({ where, data }) => { let count = 0; for (const j of jobs) if (match(j, where)) { Object.assign(j, structuredClone(data)); count++; } return { count }; },
    },
    auditLog: { create: async ({ data }) => { audits.push(data); return data; } },
    $transaction: async work => work(prisma),
  };
  const pacs = { listStudies: async (c, query) => {
    assert.deepEqual(Object.keys(query), ['uids']);
    listCalls.push(c.sub);
    return { studies: c.institution === 'inst-a' && c.sub !== 'sub-blind' ? query.uids.split(',').map(uid => ({ uid })) : [] };
  } };
  const service = new FilmPrintService(prisma, new OrthancService(), pacs);
  return { service, peers, jobs, audits, lines, requests, prisma };
}

async function rejects(promise, status, message) {
  await assert.rejects(promise, error => {
    assert.equal(error.getStatus?.(), status, `${error.message}`);
    if (message !== undefined) assert.equal(error.message, message);
    return true;
  });
}

async function ended(service, id, who = RAD) {
  for (let i = 0; i < 200; i++) {
    const { job } = await service.job(id, who);
    if (!['sending', 'sent'].includes(job.state)) return job;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('the job did not end');
}

/** A job body with the plan key of the layout it asks for (as the page sends what its preview showed). */
async function withPlan(h, extra = {}) {
  const b = body(h, extra);
  const shown = await h.service.layout({ studyUid: b.studyUid, seriesUid: b.seriesUid, format: b.format, filmSize: b.filmSize,
    orientation: b.orientation, film: b.film }, RAD);
  return { ...b, plan: shown.plan };
}

const body = (h, extra = {}) => ({ studyUid: STUDY, seriesUid: SERIES.ct.uid, format: '2x2', filmSize: '14INX17IN', orientation: 'PORTRAIT',
  film: 1, copies: 1, requestId: randomUUID(), destination: { kind: 'printer', peerId: h.peers[0].id }, ...extra });

test('pure: requests, frame order, film size, header window, rendering query, PAM and the composed film', () => {
  const F = require('/app/dist/film-print');
  assert.throws(() => F.layoutRequest({ studyUid: STUDY, format: '5x5', filmSize: '14INX17IN', orientation: 'PORTRAIT' }), /형식/);
  assert.throws(() => F.jobRequest({ ...body({ peers: [{ id: randomUUID() }] }), copies: 6 }), /형식/);
  assert.throws(() => F.jobRequest({ ...body({ peers: [{ id: randomUUID() }] }), requestId: 'x' }), /형식/);
  assert.deepEqual(F.filmPixels('14INX17IN', 'PORTRAIT'), { width: 2100, height: 2550 });
  assert.deepEqual(F.filmPixels('8INX10IN', 'LANDSCAPE'), { width: 1500, height: 1200 });
  assert.deepEqual(F.cellSize({ columns: 3, rows: 4, filmSize: '14INX17IN', orientation: 'PORTRAIT' }), { width: 700, height: 637 });
  assert.deepEqual(F.headerWindow({ center: '40\\400', width: '80\\1500' }), { center: 40, width: 80 });
  assert.equal(F.headerWindow({ center: '40', width: '0' }), null);
  assert.equal(F.headerWindow({ center: null, width: '80' }), null);
  assert.equal(F.renderQuery({ window: { center: -600, width: 1500 }, width: 700, height: 637 }), 'window-center=-600&window-width=1500&width=700&height=637');
  assert.equal(F.renderQuery({ window: null, width: 700, height: 637 }), 'width=700&height=637');
  const frames = F.framesOf([{ id: 'b', sop: '1.2', number: '2', frames: '2' }, { id: 'a', sop: '1.1', number: '10', frames: '' }, { id: 'c', sop: '1.3', number: '', frames: '1' }]);
  assert.deepEqual(frames.map(f => [f.instance, f.frame, f.order]), [['b', 1, 1], ['b', 2, 2], ['a', 1, 3], ['c', 1, 4]]);
  const grey = F.pamToGrey(pam(2, 1, 100));
  assert.deepEqual([grey.width, grey.height, [...grey.pixels]], [2, 1, [100, 100]]);
  const rgb = Buffer.concat([Buffer.from('P7\nWIDTH 1\nHEIGHT 1\nDEPTH 3\nMAXVAL 255\nTUPLTYPE RGB\nENDHDR\n'), Buffer.from([255, 0, 0])]);
  assert.deepEqual([...F.pamToGrey(rgb).pixels], [76]);
  assert.throws(() => F.pamToGrey(Buffer.from('P5\n1 1\n255\n\0')), /PAM/);
  // A 2 x 1 film of 8 x 10 portrait (1200 x 1500): each cell 600 x 1500, a 2 x 2 picture centred in it.
  const film = F.composeFilm({ columns: 2, rows: 1, filmSize: '8INX10IN', orientation: 'PORTRAIT' },
    [{ position: 2, width: 2, height: 2, pixels: Buffer.from([9, 9, 9, 9]) }]);
  assert.deepEqual([film.width, film.height], [1200, 1500]);
  assert.equal(film.pixels.reduce((s, v) => s + v, 0), 36);
  assert.equal(film.pixels[749 * 1200 + 600 + 299], 9, 'the picture sits in the middle of the second cell');
  assert.equal(F.uuidUid('00000000-0000-4000-8000-000000000001'), '2.25.' + BigInt('0x00000000000040008000000000000001').toString());
});

test('roles and the boundary: radiologist and technician; clinician refused; a study the caller does not open and another institution are 404', async t => {
  await orthanc(t);
  const h = harness(t);
  for (const who of [RAD, TECH]) assert.equal((await h.service.destinations(who)).printers.length, 2);
  await rejects(h.service.destinations(CLIN), 403);
  await rejects(h.service.layout({ studyUid: STUDY, format: '2x2', filmSize: '14INX17IN', orientation: 'PORTRAIT' }, CLIN), 403);
  await rejects(h.service.layout({ studyUid: STUDY, format: '2x2', filmSize: '14INX17IN', orientation: 'PORTRAIT' }, OTHER), 404, '검사를 찾을 수 없습니다');
  await rejects(h.service.layout({ studyUid: STUDY, format: '2x2', filmSize: '14INX17IN', orientation: 'PORTRAIT' }, { ...RAD, sub: 'sub-blind' }), 404);
  const other = await h.service.destinations(OTHER);
  assert.deepEqual(other.printers.map(p => p.name), ['SYN Other Printer']);
  await rejects(h.service.create(await withPlan(h, { destination: { kind: 'printer', peerId: h.peers[3].id } }), RAD), 404, '그 프린터나 장치가 등록돼 있지 않습니다');
});

test('destinations: printers (with their film sizes) and DICOM devices of the institution by kind', async t => {
  await orthanc(t);
  const h = harness(t);
  assert.deepEqual(await h.service.destinations(RAD), {
    printers: [{ id: h.peers[0].id, name: 'SYN Printer A', aet: 'SYNPRA', filmSizes: ['8INX10IN', '10INX12IN', '11INX14IN', '14INX17IN'] },
      { id: h.peers[1].id, name: 'SYN Printer B', aet: 'SYNPRB', filmSizes: ['14INX17IN'] }],
    devices: [{ id: h.peers[2].id, name: 'SYN Workstation', aet: 'SYNWS' }] });
});

test('layout: the printable series, the frames in order (one cell per frame), the header window and empty cells left empty', async t => {
  const state = await orthanc(t);
  const h = harness(t);
  const first = await h.service.layout({ studyUid: STUDY, format: '2x2', filmSize: '14INX17IN', orientation: 'PORTRAIT' }, RAD);
  assert.deepEqual(first.series.map(s => [s.uid, s.images]), [[SERIES.scout.uid, 1], [SERIES.ct.uid, 7]], 'no SR, no attached document');
  assert.equal(first.seriesUid, SERIES.scout.uid, 'the first series by number is the default');
  assert.equal(first.films, 1);
  const ct = await h.service.layout({ studyUid: STUDY, seriesUid: SERIES.ct.uid, format: '2x2', filmSize: '14INX17IN', orientation: 'PORTRAIT' }, RAD);
  // Nine frames: #1 (202), #2 (203), #3 (207 frames 1-3), #4..#7 (204, 205, 206, 201) - three films of four.
  assert.equal(ct.films, 3);
  assert.deepEqual(ct.cells.map(c => [c.position, c.instance, c.frame, c.order]),
    [[1, OID(202), 1, 1], [2, OID(203), 1, 2], [3, OID(207), 1, 3], [4, OID(207), 2, 4]]);
  assert.deepEqual(ct.cells.map(c => c.window), [{ center: 40, width: 80 }, null, { center: -600, width: 1500 }, { center: -600, width: 1500 }]);
  assert.deepEqual([ct.cells[0].width, ct.cells[0].height, ct.cells[0].sop], [1050, 1275, `${SERIES.ct.uid}.202`]);
  assert.equal(ct.cells[3].src, `/instances/${OID(207)}/frames/1/rendered?window-center=-600&window-width=1500&width=1050&height=1275`);
  assert.equal(ct.cells[1].src, `/instances/${OID(203)}/frames/0/rendered?width=1050&height=1275`);
  const last = await h.service.layout({ studyUid: STUDY, seriesUid: SERIES.ct.uid, format: '2x2', filmSize: '14INX17IN', orientation: 'PORTRAIT', film: 3 }, RAD);
  assert.deepEqual(last.cells.map(c => [c.position, c.order]), [[1, 9]], 'the rest of the last film stays empty');
  await rejects(h.service.layout({ studyUid: STUDY, seriesUid: SERIES.ct.uid, format: '2x2', filmSize: '14INX17IN', orientation: 'PORTRAIT', film: 4 }, RAD), 400);
  await rejects(h.service.layout({ studyUid: STUDY, seriesUid: SERIES.sr.uid, format: '2x2', filmSize: '14INX17IN', orientation: 'PORTRAIT' }, RAD), 404);
  assert.equal(state.rendered.length, 0, 'a layout reads no pixels (the page reads the same renderings for its preview)');
});

test('a print: the helper gets the cells as rendered for the preview; Sending, Sent, Printed; the job keeps each cell', async t => {
  const state = await orthanc(t);
  const h = harness(t);
  const preview = await h.service.layout({ studyUid: STUDY, seriesUid: SERIES.ct.uid, format: '2x2', filmSize: '14INX17IN', orientation: 'PORTRAIT', film: 3 }, RAD);
  const asked = await withPlan(h, { film: 3, copies: 2 });
  const { job } = await h.service.create(asked, RAD);
  assert.equal(job.state, 'sending');
  const done = await ended(h.service, job.id);
  assert.deepEqual(done.events.map(e => e.state), ['sending', 'sent', 'printed']);
  assert.equal(done.state, 'printed');
  assert.deepEqual([done.film, done.films, done.format, done.copies, done.destination.name], [3, 3, '2x2', 2, 'SYN Printer A']);
  const [request] = h.requests();
  assert.deepEqual({ action: request.action, callingAet: request.callingAet, peer: request.peer, film: request.film },
    { action: 'print', callingAet: 'KINLAB', peer: { aet: 'SYNPRA', host: '127.0.0.1', port: 11112 },
      film: { columns: 2, rows: 2, filmSize: '14INX17IN', orientation: 'PORTRAIT', copies: 2 } });
  assert.deepEqual(request.boxes, [{ position: 1, width: 10, height: 8, length: 80, sum: 80 * (1 * 10 + 0) }], 'only the filled cell, its picture as rendered');
  assert.deepEqual(state.rendered.map(r => `/instances/${r.instance}/frames/${r.frame}/rendered?${r.query}`), preview.cells.map(c => c.src),
    'the print asks Orthanc for exactly what the preview shows');
  assert.ok(state.rendered.every(r => r.accept === 'image/x-portable-arbitrarymap'));
  const row = h.jobs[0];
  assert.deepEqual(row.layout.cells.map(({ position, sop, frame, order, window, width, height }) => ({ position, sop, frame, order, window, width, height })),
    preview.cells.map(({ position, sop, frame, order, window, width, height }) => ({ position, sop, frame, order, window, width, height })));
  assert.deepEqual([row.printJobUid, row.institutionId, row.createdBy, row.destination, row.peerAet], ['1.2.3.4', 'inst-a', 'SYN-rad', 'printer', 'SYNPRA']);
  const audit = h.audits.find(a => a.action === 'film-print.job');
  assert.equal(audit.target, STUDY);
  assert.deepEqual(JSON.parse(audit.detail), { institution: 'inst-a', job: job.id, destination: 'printer', peer: h.peers[0].id, series: SERIES.ct.uid, film: 3, films: 3, cells: 1 });
  assert.ok(!/SYN\^FILM|SYN-81/.test(audit.detail), 'no patient value in the audit');
});

test('Sent then no answer, a warning kept, a helper that stops without its answer, a failure', async t => {
  await orthanc(t);
  const h = harness(t);
  h.lines([{ event: 'sent', printJobUid: '1.2.3.5', warnings: ['0xB604 image larger than its box - it was made smaller'] },
    { event: 'final', state: 'no-answer', reason: 'the printer did not report completion', warnings: ['0xB604 image larger than its box - it was made smaller'] }]);
  let job = await ended(h.service, (await h.service.create(await withPlan(h, { destination: { kind: 'printer', peerId: h.peers[1].id } }), RAD)).job.id);
  assert.deepEqual([job.events.map(e => e.state), job.reason, job.warnings], [['sending', 'sent', 'no-answer'], 'the printer did not report completion',
    ['0xB604 image larger than its box - it was made smaller']]);
  h.lines([{ event: 'sent', printJobUid: '1.2.3.6' }]);
  job = await ended(h.service, (await h.service.create(await withPlan(h), RAD)).job.id);
  assert.deepEqual([job.events.map(e => e.state), job.reason], [['sending', 'sent', 'no-answer'], 'the print helper stopped before the answer came']);
  h.lines([{ event: 'final', state: 'failed', reason: 'could not connect' }]);
  job = await ended(h.service, (await h.service.create(await withPlan(h), RAD)).job.id);
  assert.deepEqual([job.events.map(e => e.state), job.reason], [['sending', 'failed'], 'could not connect']);
});

test('the same request id answers the same job and prints nothing again; another print under it is refused', async t => {
  await orthanc(t);
  const h = harness(t);
  const asked = await withPlan(h);
  const first = await h.service.create(asked, RAD);
  await ended(h.service, first.job.id);
  const again = await h.service.create({ ...asked }, RAD);
  assert.equal(again.job.id, first.job.id);
  assert.equal(again.job.state, 'printed');
  assert.equal(h.requests().length, 1, 'the helper ran once');
  await rejects(h.service.create({ ...asked, film: 2 }, RAD), 409);
  assert.equal(h.jobs.length, 1);
  // Another member's request id is their own: the job is not theirs to read.
  await rejects(h.service.job(first.job.id, TECH), 404);
  await rejects(h.service.job(first.job.id, OTHER), 404);
});

test('a restarted server leaves its open jobs No answer and sends nothing again', async t => {
  await orthanc(t);
  const h = harness(t);
  for (const state of ['sending', 'sent', 'printed'])
    h.jobs.push({ id: randomUUID(), institutionId: 'inst-a', createdBySub: RAD.sub, requestId: randomUUID(), state, events: [{ state: 'sending', at: 'x' }],
      warnings: [], layout: {}, destination: 'printer', peerId: h.peers[0].id, peerName: 'SYN Printer A' });
  await h.service.onApplicationBootstrap();
  assert.deepEqual(h.jobs.map(j => j.state), ['no-answer', 'no-answer', 'printed']);
  assert.deepEqual(h.jobs[0].events.map(e => e.state), ['sending', 'no-answer']);
  assert.match(h.jobs[1].reason, /restarted/);
  assert.equal(h.requests().length, 0, 'nothing was sent again');
});

test('a printer only takes the film sizes it was registered for; a device id is not a printer', async t => {
  await orthanc(t);
  const h = harness(t);
  await rejects(h.service.create(await withPlan(h, { filmSize: '8INX10IN', destination: { kind: 'printer', peerId: h.peers[1].id } }), RAD), 400,
    'SYN Printer B에는 8INX10IN 필름이 등록돼 있지 않습니다');
  await rejects(h.service.create(await withPlan(h, { destination: { kind: 'printer', peerId: h.peers[2].id } }), RAD), 404);
  await rejects(h.service.create(await withPlan(h, { destination: { kind: 'device', peerId: h.peers[0].id } }), RAD), 404);
  assert.equal(h.jobs.length, 0);
});

test('to a device: one layout image of the whole film with the study identity and new UIDs, sent straight to it', async t => {
  const state = await orthanc(t);
  const h = harness(t);
  h.lines([{ event: 'sent' }, { event: 'final', state: 'stored', warnings: [] }]);
  const { job } = await h.service.create(await withPlan(h, { format: '3x4', destination: { kind: 'device', peerId: h.peers[2].id } }), TECH);
  const done = await ended(h.service, job.id, TECH);
  assert.deepEqual(done.events.map(e => e.state), ['sending', 'sent', 'stored']);
  const [request] = h.requests();
  assert.equal(request.action, 'store');
  assert.deepEqual([request.image.width, request.image.height, request.image.length], [2100, 2550, 2100 * 2550]);
  // Nine 10 x 8 pictures on the black film: their grey values (instance % 100 * 10 + frame) summed over 80 pixels each.
  const values = [2 * 10, 3 * 10, 7 * 10, 7 * 10 + 1, 7 * 10 + 2, 4 * 10, 5 * 10, 6 * 10, 1 * 10];
  assert.equal(request.image.sum, values.reduce((s, v) => s + v * 80, 0));
  const row = h.jobs[0];
  assert.match(row.outputSeriesUid, /^2\.25\.\d+$/);
  assert.match(row.outputSopUid, /^2\.25\.\d+$/);
  assert.deepEqual(request.attributes, { PatientName: 'SYN^FILM', PatientID: 'SYN-81', PatientBirthDate: '19700101', PatientSex: 'O',
    StudyInstanceUID: STUDY, StudyDate: '20261101', StudyTime: '101500', StudyID: 'S81', AccessionNumber: 'SYNACC81', StudyDescription: 'SYN CT',
    SeriesInstanceUID: row.outputSeriesUid, SOPInstanceUID: row.outputSopUid, SeriesNumber: '9900', InstanceNumber: '1',
    SeriesDescription: 'Print layout 3x4', Modality: 'OT', ConversionType: 'WSD',
    SeriesDate: request.attributes.SeriesDate, SeriesTime: request.attributes.SeriesTime, ContentDate: request.attributes.ContentDate, ContentTime: request.attributes.ContentTime });
  assert.ok(!state.requests.some(r => r.method !== 'GET' && r.url !== '/tools/lookup'), 'nothing is written to this archive');
});

test('the print is the film the preview showed: an image that arrived since is refused and nothing is sent', async t => {
  const state = await orthanc(t);
  const h = harness(t);
  const asked = await withPlan(h);
  // A new image numbered before the first one arrives after the preview: the film would now hold other images.
  state.extra.push(OID(208));
  NUMBER[OID(208)] = '0';
  t.after(() => { delete NUMBER[OID(208)]; });
  await assert.rejects(h.service.create(asked, RAD), error => {
    assert.equal(error.getStatus(), 409);
    assert.deepEqual(error.getResponse(), { code: 'FILM_PLAN_CHANGED', message: '미리보기를 연 뒤 이 시리즈의 영상이 바뀌었습니다 — 바뀐 미리보기를 확인하고 다시 인쇄하세요' });
    return true;
  });
  assert.equal(h.jobs.length, 0);
  assert.equal(h.requests().length, 0);
  assert.equal(state.rendered.length, 0, 'no image was read for a print');
  const again = await withPlan(h);
  assert.notEqual(again.plan, asked.plan);
  assert.equal((await ended(h.service, (await h.service.create(again, RAD)).job.id)).state, 'printed');
});
