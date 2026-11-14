'use strict';
/* FC-070 Query/Retrieve: the API's search of another PACS and its retrieve, against a synthetic Orthanc on 127.0.0.1
 * that records every request (the modality it is told about, the C-FIND identifier, the C-MOVE body) and answers like
 * Orthanc 1.12.5 (`/modalities/{key}/query` → `{ID}`, `/queries/{id}/answers?expand&simplify`, an asynchronous
 * `/modalities/{key}/move` → `{ID, Path}`, `/jobs/{id}`, `/system` DicomAet, PUT/DELETE of a modality answering an empty
 * text, a refused C-FIND as HTTP 500 with "… has failed with DIMSE status 0x…"). The database and the worklist's own
 * targeted read (PacsService.listStudies) are in-memory stand-ins. No DB, credentials or external network.
 */
require('./service_test_loader.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');

process.env.ORTHANC_USER = process.env.ORTHANC_USER || 'SYN';
process.env.ORTHANC_PASS = process.env.ORTHANC_PASS || 'SYN';

const A = '1.2.826.0.1.3680043.8.498.71', B = '1.2.826.0.1.3680043.8.498.72', C = '1.2.826.0.1.3680043.8.498.73';
const RAD = { sub: 'sub-rad', actor: 'SYN-rad', roles: ['radiologist'], institution: 'inst-a', kind: 'member' };
const TECH = { sub: 'sub-tech', actor: 'SYN-tech', roles: ['technician'], institution: 'inst-a', kind: 'member' };
const ADMIN = { sub: 'sub-admin', actor: 'SYN-admin', roles: ['admin'], institution: 'inst-a', kind: 'member' };
const OTHER = { sub: 'sub-other', actor: 'SYN-other', roles: ['radiologist'], institution: 'inst-b', kind: 'member' };
const CLIN = { sub: 'sub-clin', actor: 'SYN-clin', roles: ['clinician'], institution: 'inst-a', kind: 'member' };
const GATEWAY = { sub: 'sub-gw', actor: 'SYN-gw', roles: ['gateway'], institution: 'inst-a', kind: 'gateway' };

/** A synthetic Orthanc. `state` is mutable by each test: answers, job, local counts, failures. */
async function orthanc(t) {
  const state = { modalities: new Map(), requests: [], answers: [], job: { State: 'Pending', Progress: 0 }, counts: new Map(),
    findFailure: null, moveFailure: null, deleteStatus: 200, putGate: null };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8'), body = raw ? JSON.parse(raw) : undefined;
    state.requests.push({ method: req.method, url: req.url, body });
    const send = (status, value) => { const text = value === undefined ? '' : JSON.stringify(value);
      res.writeHead(status, { 'Content-Type': value === undefined ? 'text/plain' : 'application/json', 'Content-Length': Buffer.byteLength(text) }); res.end(text); };
    const modality = /^\/modalities\/([^/]+)(\/(query|move))?$/.exec(req.url);
    if (req.url === '/system') return send(200, { DicomAet: 'KINLAB', Version: '1.12.5' });
    if (modality && !modality[2] && req.method === 'PUT') {
      if (state.putGate) await state.putGate;
      state.modalities.set(decodeURIComponent(modality[1]), body); return send(200);
    }
    if (modality && !modality[2] && req.method === 'DELETE') {
      if (state.deleteStatus !== 200) return send(state.deleteStatus, { Message: 'SYN failure' });
      state.modalities.delete(decodeURIComponent(modality[1])); return send(200);
    }
    if (modality?.[3] === 'query') {
      if (!state.modalities.has(decodeURIComponent(modality[1]))) return send(404, { Message: 'Inexistent modality' });
      if (state.findFailure) return send(500, state.findFailure);
      return send(200, { ID: 'q-1', Path: '/queries/q-1' });
    }
    if (req.url === '/queries/q-1/answers?expand&simplify') return send(200, state.answers);
    if (modality?.[3] === 'move') {
      if (state.moveFailure) return send(500, state.moveFailure);
      return send(200, { ID: 'job-1', Path: '/jobs/job-1' });
    }
    if (req.url === '/jobs/job-1') return send(200, { ID: 'job-1', Type: 'DicomMoveScu', ...state.job });
    if (req.url === '/tools/find' && req.method === 'POST') {
      const uids = String(body?.Query?.StudyInstanceUID ?? '').split('\\');
      return send(200, uids.filter(uid => state.counts.has(uid)).map(uid => ({ ID: 'x', Type: 'Study',
        RequestedTags: { StudyInstanceUID: uid, NumberOfStudyRelatedInstances: String(state.counts.get(uid)) } })));
    }
    send(404, { Message: 'SYN not found ' + req.url });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  process.env.ORTHANC_URL = 'http://127.0.0.1:' + server.address().port;
  return state;
}

/** The in-memory database the service touches, and the worklist's targeted read (which UIDs the caller's list opens). */
function harness(state) {
  const { QueryRetrieveService } = require('/app/dist/query-retrieve.service');
  const { OrthancService } = require('/app/dist/orthanc.service');
  const peers = [], audits = [], studyStates = new Map(), openable = new Map(), listCalls = [];
  const prisma = {
    dicomPeer: {
      findMany: async ({ where, select }) => peers.filter(p => p.institutionId === where.institutionId && (where.kind === undefined || p.kind === where.kind))
        .sort((x, y) => x.name.localeCompare(y.name)).map(p => select ? { id: p.id, name: p.name } : { ...p }),
      findFirst: async ({ where }) => peers.find(p => p.id === where.id && p.institutionId === where.institutionId && (where.kind === undefined || p.kind === where.kind)) ?? null,
      create: async ({ data }) => {
        if (peers.some(p => p.institutionId === data.institutionId && p.aet === data.aet)) throw Object.assign(new Error('unique'), { code: 'P2002' });
        const row = { id: randomUUID(), createdAt: new Date('2026-11-11T00:00:00Z'), ...data }; peers.push(row); return { ...row };
      },
      delete: async ({ where }) => peers.splice(peers.findIndex(p => p.id === where.id), 1)[0],
    },
    auditLog: { create: async ({ data }) => { audits.push(data); return data; } },
    studyState: { findUnique: async ({ where }) => studyStates.get(where.uid) ?? null },
    $transaction: async work => work(prisma),
  };
  const pacs = { listStudies: async (c, query) => {
    assert.deepEqual(Object.keys(query), ['uids']);
    listCalls.push({ institution: c.institution, uids: query.uids.split(',') });
    return { studies: query.uids.split(',').filter(uid => openable.get(uid)?.has(c.sub)).map(uid => ({ uid })) };
  } };
  const service = new QueryRetrieveService(prisma, new OrthancService(), pacs);
  return { service, peers, audits, studyStates, openable, listCalls, state };
}

async function rejects(promise, status, message) {
  await assert.rejects(promise, error => {
    assert.equal(error.getStatus?.(), status, `${error.message}`);
    if (message !== undefined) assert.equal(error.message, message);
    return true;
  });
}

const peerBody = { name: 'SYN Hospital PACS', aet: 'SYNPEER', host: 'pacs.synthetic.test', port: 104 };
async function withPeer(t) {
  const state = await orthanc(t);
  const h = harness(state);
  const { peer } = await h.service.registerPeer(peerBody, ADMIN);
  return { ...h, peer, key: `kin-inst-a-${peer.id}` };
}
const answer = (uid, extra = {}) => ({ StudyInstanceUID: uid, PatientID: 'P-SYN-1', PatientName: 'SYN^PATIENT', StudyDate: '20261101',
  ModalitiesInStudy: 'CT\\SR', StudyDescription: 'SYN CT', AccessionNumber: 'ACC-SYN-1', NumberOfStudyRelatedInstances: '3', ...extra });

test('FC-070 the search criteria: one of patient ID, name (2+), accession or date carries a value beyond blanks and wildcards', () => {
  const { searchCriteria, QR_MESSAGES } = require('/app/dist/query-retrieve');
  const refuse = body => assert.throws(() => searchCriteria({ peerId: 'p', ...body }), error => error.message === QR_MESSAGES.criteria);
  for (const body of [{}, { patientId: '   ' }, { patientId: '*' }, { patientId: ' *?* ' }, { patientName: 'K' }, { patientName: 'K*' },
    { accession: '**' }, { modality: 'CT' }, { patientName: '?*', modality: 'MR' }]) refuse(body);
  assert.equal(QR_MESSAGES.criteria, '환자번호·이름·접수번호·검사일 중 하나는 넣어야 합니다');
  assert.deepEqual(searchCriteria({ peerId: 'p', patientName: 'KIM*' }).fields, ['patientName']);
  assert.deepEqual(searchCriteria({ peerId: 'p', patientId: 'P-1*', modality: 'ct' }).query, { PatientID: 'P-1*', PatientName: '',
    AccessionNumber: '', StudyDate: '', ModalitiesInStudy: 'CT', StudyInstanceUID: '', StudyDescription: '', NumberOfStudyRelatedInstances: '' });
  assert.equal(searchCriteria({ peerId: 'p', studyDateFrom: '2026-11-01' }).query.StudyDate, '20261101-');
  assert.equal(searchCriteria({ peerId: 'p', studyDateFrom: '2026-11-01', studyDateTo: '20261103' }).query.StudyDate, '20261101-20261103');
  assert.equal(searchCriteria({ peerId: 'p', studyDateTo: '2026-11-03' }).query.StudyDate, '-20261103');
  assert.throws(() => searchCriteria({ peerId: 'p', studyDateFrom: '2026-02-30' }), /YYYY-MM-DD/);
  assert.throws(() => searchCriteria({ peerId: 'p', studyDateFrom: '2026-11-03', studyDateTo: '2026-11-01' }), /늦습니다/);
  assert.throws(() => searchCriteria({ peerId: 'p', patientId: 'A\\B' }), /64자/);
});

test('FC-070 roles: radiologist and technician search, admin registers; clinician, gateway and members on admin routes are refused', async t => {
  const { service, peer } = await withPeer(t);
  for (const who of [CLIN, GATEWAY]) {
    await rejects(service.peers(who), 403);
    await rejects(service.search({ peerId: peer.id, patientId: 'P-1' }, who), 403);
    await rejects(service.retrieve({ peerId: peer.id, studyUid: A }, who), 403);
    await rejects(service.job('x', who), 403);
  }
  for (const who of [RAD, TECH]) {
    assert.deepEqual(await service.peers(who), { peers: [{ id: peer.id, name: peerBody.name }] });
    await rejects(service.adminPeers(who), 403);
    await rejects(service.registerPeer(peerBody, who), 403);
    await rejects(service.removePeer(peer.id, who), 403);
  }
});

test('FC-070 the institution boundary: another institution\'s peer, search answers and jobs are 404', async t => {
  const { service, peer, state } = await withPeer(t);
  assert.deepEqual(await service.peers(OTHER), { peers: [], message: '등록된 상대 PACS가 없습니다 — 관리자가 Members ▸ DICOM Peers에서 등록합니다' });
  assert.deepEqual((await service.adminPeers({ ...ADMIN, institution: 'inst-b' })).peers, []);
  await rejects(service.search({ peerId: peer.id, patientId: 'P-1' }, OTHER), 404, '상대 PACS를 찾을 수 없습니다');
  await rejects(service.retrieve({ peerId: peer.id, studyUid: A }, OTHER), 404);
  await rejects(service.removePeer(peer.id, { ...ADMIN, institution: 'inst-b' }), 404);
  await rejects(service.search({ peerId: 'not-a-uuid', patientId: 'P-1' }, RAD), 404);
  // A retrieve needs the caller's own search answer for that study on that peer.
  state.answers = [answer(A)];
  await rejects(service.retrieve({ peerId: peer.id, studyUid: A }, RAD), 404, '이 상대 PACS의 검색 결과에 없는 검사입니다 — 다시 검색하세요');
  await service.search({ peerId: peer.id, patientId: 'P-SYN-1' }, RAD);
  await rejects(service.retrieve({ peerId: peer.id, studyUid: A }, TECH), 404);
  const { jobId } = await service.retrieve({ peerId: peer.id, studyUid: A }, RAD);
  await rejects(service.job(jobId, TECH), 404, '가져오기 작업을 찾을 수 없습니다');
  await rejects(service.job(jobId, { ...RAD, institution: 'inst-b' }), 404);
  assert.equal((await service.job(jobId, RAD)).state, 'pending');
});

test('FC-070 Orthanc is told the peer with every Allow* written (no find, get or move back into this archive); query and move bodies', async t => {
  const { service, peer, key, state } = await withPeer(t);
  assert.equal(state.modalities.size, 0, 'registration alone puts nothing in Orthanc');
  state.answers = [answer(A), answer(B, { NumberOfStudyRelatedInstances: '' })];
  const found = await service.search({ peerId: peer.id, patientName: 'SYN*', studyDateFrom: '2026-11-01', modality: 'ct' }, RAD);
  assert.deepEqual(state.modalities.get(key), { AET: 'SYNPEER', Host: 'pacs.synthetic.test', Port: 104,
    AllowEcho: true, AllowStore: true, AllowFind: false, AllowFindWorklist: false, AllowGet: false, AllowMove: false });
  const query = state.requests.find(r => r.url === `/modalities/${encodeURIComponent(key)}/query`);
  assert.deepEqual(query.body, { Level: 'Study', Query: { PatientID: '', PatientName: 'SYN*', AccessionNumber: '', StudyDate: '20261101-',
    ModalitiesInStudy: 'CT', StudyInstanceUID: '', StudyDescription: '', NumberOfStudyRelatedInstances: '' } });
  assert.deepEqual(found, { truncated: false, rows: [
    { studyUid: A, patientId: 'P-SYN-1', patientName: 'SYN PATIENT', studyDate: '20261101', modality: 'CT,SR', description: 'SYN CT', accession: 'ACC-SYN-1', instances: 3, here: false },
    { studyUid: B, patientId: 'P-SYN-1', patientName: 'SYN PATIENT', studyDate: '20261101', modality: 'CT,SR', description: 'SYN CT', accession: 'ACC-SYN-1', instances: null, here: false }] });
  state.modalities.clear();
  const { jobId } = await service.retrieve({ peerId: peer.id, studyUid: A }, RAD);
  assert.ok(state.modalities.has(key), 'the modality is put again on every use');
  const move = state.requests.find(r => r.url === `/modalities/${encodeURIComponent(key)}/move`);
  assert.deepEqual(move.body, { Level: 'Study', Resources: [{ StudyInstanceUID: A }], TargetAet: 'KINLAB', Asynchronous: true });
  assert.match(jobId, /^[0-9a-f-]{36}$/, 'the job id is the API\'s own, not Orthanc\'s');
});

test('FC-070 200 answers is the display and response cap: more come back truncated with the screen\'s wording', async t => {
  const { service, peer, state } = await withPeer(t);
  state.answers = Array.from({ length: 250 }, (_, i) => answer(`1.2.826.0.1.3680043.8.498.9${i}`));
  const found = await service.search({ peerId: peer.id, accession: 'ACC*' }, TECH);
  assert.equal(found.rows.length, 200);
  assert.equal(found.truncated, true);
  assert.equal(found.message, '200건까지만 보입니다 — 조건을 좁히세요');
  state.answers = state.answers.slice(0, 200);
  const exact = await service.search({ peerId: peer.id, accession: 'ACC*' }, TECH);
  assert.deepEqual([exact.rows.length, exact.truncated, 'message' in exact], [200, false, false]);
});

test('FC-070 Here is on only for a study this archive holds and the caller\'s own list opens', async t => {
  const { service, peer, state, openable, listCalls } = await withPeer(t);
  state.answers = [answer(A), answer(B), answer(C)];
  state.counts.set(A, 3); state.counts.set(B, 3);       // C is not here at all
  openable.set(A, new Set([RAD.sub]));                  // B is here but this member's list does not open it
  const found = await service.search({ peerId: peer.id, patientId: 'P-SYN-1' }, RAD);
  assert.deepEqual(found.rows.map(r => [r.studyUid, r.here]), [[A, true], [B, false], [C, false]]);
  assert.deepEqual(listCalls, [{ institution: 'inst-a', uids: [A, B] }], 'only held UIDs go to the worklist\'s read');
  const asTech = await service.search({ peerId: peer.id, patientId: 'P-SYN-1' }, TECH);
  assert.deepEqual(asTech.rows.map(r => r.here), [false, false, false]);
});

test('FC-070 a retrieve\'s state: pending, running, then arrived / held / failed by what actually arrived', async t => {
  const { service, peer, state, openable, studyStates } = await withPeer(t);
  state.answers = [answer(A)];
  await service.search({ peerId: peer.id, patientId: 'P-SYN-1' }, RAD);
  const run = async (job, arrived, setup = () => {}) => {
    state.job = { State: 'Pending', Progress: 0 }; state.counts.delete(A); openable.delete(A); studyStates.delete(A);
    const { jobId } = await service.retrieve({ peerId: peer.id, studyUid: A }, RAD);
    assert.deepEqual(await service.job(jobId, RAD), { state: 'pending', progress: 0, reason: null });
    state.job = { State: 'Running', Progress: 42.4 };
    assert.deepEqual(await service.job(jobId, RAD), { state: 'running', progress: 42, reason: null });
    state.job = job; if (arrived !== null) state.counts.set(A, arrived); setup();
    const answerNow = await service.job(jobId, RAD);
    state.job = { State: 'Running', Progress: 1 };
    assert.deepEqual(await service.job(jobId, RAD), answerNow, 'an ended answer is kept');
    return answerNow;
  };
  const success = { State: 'Success', Progress: 100 };
  assert.deepEqual(await run(success, 3, () => openable.set(A, new Set([RAD.sub]))), { state: 'arrived', progress: 100, reason: null });
  assert.deepEqual(await run(success, 3, () => studyStates.set(A, { institutionId: null })),
    { state: 'held', progress: 100, reason: '보낸 장비가 등록되지 않아 보류됐습니다. 관리자가 Held Studies에서 등록합니다' });
  assert.deepEqual(await run(success, 2, () => openable.set(A, new Set([RAD.sub]))),
    { state: 'failed', progress: 100, reason: '일부만 받았습니다' }, 'fewer instances than the peer answered is not success');
  assert.deepEqual(await run({ State: 'Failure', Progress: 50, ErrorCode: 9 }, 1),
    { state: 'failed', progress: 100, reason: '일부만 받았습니다' });
  assert.deepEqual(await run({ State: 'Failure', Progress: 0, ErrorCode: 9 }, null),
    { state: 'failed', progress: 100, reason: '가져오지 못했습니다 — 상대 PACS에 HALO PACS(AE KINLAB)가 목적지로 등록돼 있는지 확인하세요' });
  assert.deepEqual(await run(success, null),
    { state: 'failed', progress: 100, reason: '가져오지 못했습니다 — 상대 PACS에 HALO PACS(AE KINLAB)가 목적지로 등록돼 있는지 확인하세요' },
    'a job that succeeded with nothing arrived is not arrived');
});

test('FC-070 the peer\'s refusal and an unreachable peer are worded apart', async t => {
  const { service, peer, state } = await withPeer(t);
  state.findFailure = { HttpError: 'Internal Server Error', HttpStatus: 500, Message: 'Error in the network protocol',
    Details: 'C-FIND SCU to AET "SYNPEER" has failed with DIMSE status 0xA700', OrthancError: 'Error in the network protocol' };
  await rejects(service.search({ peerId: peer.id, patientId: 'P-1' }, RAD), 502, '상대 PACS가 요청을 거절했습니다 (0xA700)');
  state.findFailure = { HttpError: 'Internal Server Error', HttpStatus: 500, Message: 'Error in the network protocol',
    Details: 'DicomAssociation - connecting to AET "SYNPEER": Failed to establish association (TCP Initialization Error: Connection refused)' };
  await rejects(service.search({ peerId: peer.id, patientId: 'P-1' }, RAD), 502, '상대 PACS(SYN Hospital PACS)에 연결하지 못했습니다');
});

test('FC-070 peers: registration checks and one AE Title per institution; removal deletes Orthanc\'s modality first', async t => {
  const { service, peer, key, state, peers, audits } = await withPeer(t);
  for (const [body, message] of [[{ ...peerBody, name: ' ' }, /이름/], [{ ...peerBody, aet: 'A\\B' }, /AE Title/], [{ ...peerBody, aet: 'X'.repeat(17) }, /AE Title/],
    [{ ...peerBody, host: 'bad host' }, /Host/], [{ ...peerBody, port: 0 }, /Port/], [{ ...peerBody, port: '70000' }, /Port/]])
    await assert.rejects(service.registerPeer(body, ADMIN), error => error.getStatus() === 400 && message.test(error.message));
  await rejects(service.registerPeer({ ...peerBody, name: 'again' }, ADMIN), 409);
  const other = await service.registerPeer({ ...peerBody, port: '11112' }, { ...ADMIN, institution: 'inst-b' });
  assert.equal(other.peer.port, 11112, 'another institution may register the same AE Title');
  assert.deepEqual(audits.filter(a => a.action === 'institution.dicom-peer.register').map(a => [a.target, JSON.parse(a.detail).institution]),
    [[peer.id, 'inst-a'], [other.peer.id, 'inst-b']]);
  // Removal: an Orthanc failure keeps the row (nothing left registered unseen); then Orthanc's entry and the row go.
  state.modalities.set(key, {});
  state.deleteStatus = 500;
  await rejects(service.removePeer(peer.id, ADMIN), 503);
  assert.ok(peers.some(p => p.id === peer.id));
  state.deleteStatus = 200;
  assert.deepEqual(await service.removePeer(peer.id, ADMIN), { removed: peer.id });
  assert.equal(state.modalities.has(key), false);
  assert.ok(state.requests.some(r => r.method === 'DELETE' && r.url === '/modalities/' + encodeURIComponent(key)));
  assert.equal(peers.some(p => p.id === peer.id), false);
  const removed = audits.find(a => a.action === 'institution.dicom-peer.remove');
  assert.deepEqual([removed.target, JSON.parse(removed.detail).institution], [peer.id, 'inst-a']);
});

test('FC-070 the audit keeps criteria names, counts and identifiers - never a patient value', async t => {
  const { service, peer, audits, state } = await withPeer(t);
  state.answers = [answer(A, { PatientID: 'P-SECRET-9', PatientName: 'HONG^SECRET' })];
  await service.search({ peerId: peer.id, patientId: 'P-SECRET-9', patientName: 'HONG*', accession: 'ACC-SECRET', studyDateFrom: '2026-11-01' }, RAD);
  const { jobId } = await service.retrieve({ peerId: peer.id, studyUid: A }, RAD);
  const search = audits.find(a => a.action === 'query-retrieve.search'), retrieve = audits.find(a => a.action === 'query-retrieve.retrieve');
  assert.deepEqual(JSON.parse(search.detail), { institution: 'inst-a', peer: peer.id, fields: ['patientId', 'patientName', 'accession', 'studyDate'], count: 1, truncated: false });
  assert.equal(search.target, peer.id);
  assert.deepEqual([retrieve.target, JSON.parse(retrieve.detail)], [A, { institution: 'inst-a', peer: peer.id, job: jobId }]);
  const all = JSON.stringify(audits);
  for (const secret of ['P-SECRET-9', 'HONG', 'SECRET', 'ACC-SECRET', '20261101']) assert.equal(all.includes(secret), false, secret);
  const { auditRule } = require('/app/dist/admin-audit');
  for (const action of ['query-retrieve.search', 'query-retrieve.retrieve', 'institution.dicom-peer.register', 'institution.dicom-peer.remove'])
    assert.equal(auditRule(action), 'field:detail.institution', action);
});

test('FC-070 a removal and a search of the same peer take turns: Orthanc never keeps a modality for a removed peer', async t => {
  const { service, peer, key, state, peers } = await withPeer(t);
  state.answers = [answer(A)];
  // The search's modality write is held at Orthanc while the administrator removes the peer.
  let release;
  state.putGate = new Promise(resolve => { release = resolve; });
  const search = service.search({ peerId: peer.id, patientId: 'P-SYN-1' }, RAD);
  await new Promise(resolve => setTimeout(resolve, 100));
  const removal = service.removePeer(peer.id, ADMIN);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(peers.some(p => p.id === peer.id), 'the removal waits for the write in flight');
  state.putGate = null; release();
  await search.catch(() => {});   // the C-FIND may or may not still find the modality: either is fine
  assert.deepEqual(await removal, { removed: peer.id });
  assert.equal(state.modalities.has(key), false, 'no modality left for the removed peer');
  // A search that comes after the removal reads the peer again in its turn: 404, and Orthanc is not written.
  const puts = state.requests.filter(r => r.method === 'PUT').length;
  await rejects(service.search({ peerId: peer.id, patientId: 'P-SYN-1' }, RAD), 404, '상대 PACS를 찾을 수 없습니다');
  assert.equal(state.requests.filter(r => r.method === 'PUT').length, puts);
  assert.equal(state.modalities.has(key), false);
});
test('Film / DICOM Print: a registered film printer is never a Query/Retrieve peer; its kind and film sizes are checked and kept', async t => {
  const { service, peer, state } = await withPeer(t);
  const { peer: printer } = await service.registerPeer({ name: 'SYN Film Printer', aet: 'SYNPRINT', host: 'printer.synthetic.test', port: 11112,
    kind: 'printer', filmSizes: ['14INX17IN', '8INX10IN'] }, ADMIN);
  assert.deepEqual([printer.kind, printer.filmSizes], ['printer', '8INX10IN,14INX17IN']);
  assert.deepEqual([peer.kind, peer.filmSizes], ['store', ''], 'a peer registered without a kind stays another PACS');
  assert.deepEqual((await service.adminPeers(ADMIN)).peers.map(p => [p.aet, p.kind, p.filmSizes]),
    [['SYNPRINT', 'printer', '8INX10IN,14INX17IN'], ['SYNPEER', 'store', '']]);
  assert.deepEqual(await service.peers(RAD), { peers: [{ id: peer.id, name: peerBody.name }] }, 'the printer is not offered to search');
  await rejects(service.search({ peerId: printer.id, patientId: 'P-1' }, RAD), 404, '상대 PACS를 찾을 수 없습니다');
  await rejects(service.retrieve({ peerId: printer.id, studyUid: A }, RAD), 404);
  assert.equal(state.modalities.has(`kin-inst-a-${printer.id}`), false, 'Orthanc is never told about a printer');
  for (const bad of [{ kind: 'modality' }, { kind: 'printer', filmSizes: ['A4'] }, { kind: 'store', filmSizes: ['14INX17IN'] }, { kind: 'printer', filmSizes: '14INX17IN' }])
    await rejects(service.registerPeer({ ...peerBody, aet: 'SYNBAD', ...bad }, ADMIN), 400);
  assert.deepEqual(await service.removePeer(printer.id, ADMIN), { removed: printer.id }, 'a printer is removed like any peer');
});