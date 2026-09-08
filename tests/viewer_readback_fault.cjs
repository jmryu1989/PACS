// Invoked only by test_measurement_readback.py with its owned fixture. Real
// compiled services/Prisma/Orthanc; HTTP faults live in this process alone.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaService } = require('/app/dist/prisma.service');
const { OrthancService } = require('/app/dist/orthanc.service');
const { ViewerService } = require('/app/dist/viewer.service');
const prisma = new PrismaService(), orthanc = new OrthancService();
const service = new ViewerService(prisma, orthanc), realFetch = global.fetch;
const { uid, caller } = fixture;
const raw = command => Buffer.from(JSON.stringify(command));
let phase = 'setup';
const watchdog = setTimeout(() => { console.error('READBACK timeout at '+phase); process.exit(1); }, 55000);

async function persisted() {
  return Promise.all([
    prisma.viewerItem.findMany({ where: { studyUid: uid }, orderBy: { id: 'asc' } }),
    prisma.viewerRevision.findMany({ where: { item: { studyUid: uid } }, orderBy: [{ itemId: 'asc' }, { revision: 'asc' }] }),
    prisma.viewerRequest.findMany({ where: { result: { item: { studyUid: uid } } }, orderBy: { requestId: 'asc' } }),
    prisma.viewerStorageBudget.findUnique({ where: { studyUid: uid } }),
    prisma.auditLog.findMany({ where: { target: uid }, orderBy: { id: 'asc' } }),
  ]);
}

async function run() {
  const found = await orthanc.viewerJson('/tools/lookup', uid);
  assert.equal(found.length, 1); assert.equal(found[0].Type, 'Study');
  const instances = await orthanc.viewerJson('/studies/'+found[0].ID+'/instances');
  assert.equal(instances.length, 8);
  const sopUids = instances.map(i => i.MainDicomTags.SOPInstanceUID);
  const heads = [], commands = [];
  for (const sop of sopUids) {
    const tags = await orthanc.viewerReference(sop, true);
    assert.equal(tags.StudyInstanceUID, uid);
    assert.match(tags.PatientID, /^READBACK-/);
    const z = Number(String(tags.ImagePositionPatient).split('\\')[2]);
    const item = { schemaVersion: 1, kind: 'length', seriesUid: tags.SeriesInstanceUID,
      sopUid: sop, frame: 1, frameOfReferenceUid: tags.FrameOfReferenceUID,
      points: [[10, 10, z], [30, 10, z]], viewPlaneNormal: [0, 0, 1], viewUp: [0, 1, 0],
      label: 'readback', baseline: { calculator: 'kin-native-manual-v1', values: [20] } };
    const command = { requestId: randomUUID(), item };
    heads.push(await service.write(uid, raw(command), caller)); commands.push(command);
  }
  const duplicate = await service.write(uid, raw({ ...commands[0], requestId: randomUUID() }), caller);
  const first = heads[0].item;
  const key = await service.write(uid, raw({ requestId: randomUUID(), item: { schemaVersion: 1,
    kind: 'key', seriesUid: first.seriesUid, sopUid: first.sopUid, frame: 1, title: 'key', description: '' } }), caller);
  const arrow = await service.write(uid, raw({ requestId: randomUUID(), item: { schemaVersion: 1,
    kind: 'arrow', seriesUid: first.seriesUid, sopUid: first.sopUid, frame: 1,
    frameOfReferenceUid: first.frameOfReferenceUid, label: 'arrow', points: first.points } }), caller);
  const baseline = await persisted();
  const replay = await service.write(uid, raw(commands[0]), caller);
  assert.deepEqual(replay, heads[0]);

  // A changed digest on readback must not become verified merely because the
  // original request succeeded. The actual DICOM and saved witness stay intact.
  global.fetch = async (url, options) => {
    const response = await realFetch(url, options);
    if (String(url).endsWith('/attachments/dicom/info')) {
      const info = await response.json(); assert.notEqual(info.UncompressedMD5, '0'.repeat(32));
      return new Response(JSON.stringify({ ...info, UncompressedMD5: '0'.repeat(32) }));
    }
    return response;
  };
  const changed = await service.write(uid, raw(commands[0]), caller);
  assert.equal(changed.referenceStatus, 'unverified');
  assert.deepEqual(changed.item, heads[0].item);
  global.fetch = realFetch;

  // First isolate one failed SOP while the others succeed, proving per-page
  // deduplication. Then stall every source to measure the queue/deadline bound.
  let active = 0, peak = 0, aborted = 0;
  const calls = new Map(), failed = sopUids[1], good = sopUids[0];
  global.fetch = async (url, options) => {
    if (String(url).endsWith('/tools/lookup') && sopUids.includes(options?.body)) {
      const sop = options.body; calls.set(sop, (calls.get(sop)||0)+1);
      if (sop === failed) throw new Error('owned immediate fault');
    }
    return realFetch(url, options);
  };
  const partial = await service.list(uid, { limit: '100' }, caller);
  assert.equal(partial.items.length, 11);
  assert.equal(calls.get(good), 1, 'same SOP verified once per page');
  for (const head of partial.items) {
    if (head.item.kind === 'length') assert.equal(head.referenceStatus, head.item.sopUid === failed ? 'unverified' : 'verified');
  }
  assert.ok(partial.items.some(h => h.id === duplicate.id && h.referenceStatus === 'verified'));
  calls.clear();
  global.fetch = async (url, options) => {
    if (!String(url).endsWith('/tools/lookup') || !sopUids.includes(options?.body)) return realFetch(url, options);
    calls.set(options.body, (calls.get(options.body)||0)+1); active++; peak = Math.max(peak, active);
    try {
      return await new Promise((resolve, reject) => {
        assert.ok(options.signal);
        const stop = () => { aborted++; reject(new Error('owned cancelled request')); };
        if (options.signal.aborted) stop(); else options.signal.addEventListener('abort', stop, { once: true });
      });
    } finally { active--; }
  };
  const started = performance.now(), stalled = await service.list(uid, { limit: '100' }, caller);
  assert.ok(performance.now()-started < 5000, 'page deadline must precede the browser abort');
  assert.equal(peak, 4); assert.equal(active, 0); assert.equal(aborted, 4);
  assert.equal(calls.size, 4, 'unstarted sources must remain queued after deadline');
  assert.equal(stalled.items.length, 11);
  assert.ok(stalled.items.filter(h=>h.item.kind==='length').every(h=>h.referenceStatus==='unverified'));
  assert.ok(stalled.items.some(h=>h.id===key.id)); assert.ok(stalled.items.some(h=>h.id===arrow.id));
  const outageReplay = await service.write(uid, raw(commands[0]), caller);
  assert.equal(outageReplay.referenceStatus, 'unverified');
  assert.deepEqual(outageReplay.item, heads[0].item);
  global.fetch = realFetch;
  assert.deepEqual(await persisted(), baseline, 'read/replay must not write history, receipt, audit or budget');

  // Exercise Node's real fetch/body cancellation too: the local proxy forwards
  // real lookup/tags, then leaves four attachment JSON bodies unfinished.
  phase = 'HTTP body cancellation'; console.log(phase);
  const http = require('node:http');
  let bodyStarted = 0, bodyClosed = 0, allClosed;
  const closed = new Promise(resolve => { allClosed = resolve; });
  const server = http.createServer(async (request, response) => {
    try {
      if (request.url.endsWith('/attachments/dicom/info')) {
        bodyStarted++;
        response.on('close', () => { if (++bodyClosed === 4) allClosed(); });
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.write('{'); return;
      }
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const upstream = await realFetch(orthanc.base+request.url, {
        method: request.method, headers: { Authorization: request.headers.authorization },
        ...(request.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
        signal: AbortSignal.timeout(3000),
      });
      response.writeHead(upstream.status, { 'Content-Type': 'application/json' });
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch { response.writeHead(503); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  phase = 'HTTP listening'; console.log(phase);
  try {
    const slow = new OrthancService(); slow.base = 'http://127.0.0.1:'+server.address().port;
    const bodyResult = await new ViewerService(prisma, slow).list(uid, { limit: '100' }, caller);
    phase = 'HTTP body closure'; console.log(phase);
    assert.equal(bodyResult.items.length, 11);
    assert.ok(bodyResult.items.filter(h=>h.item.kind==='length').every(h=>h.referenceStatus==='unverified'));
    let timeout;
    try { await Promise.race([closed, new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('HTTP bodies remained open after cancellation')), 1500);
    })]); } finally { clearTimeout(timeout); }
    assert.equal(bodyStarted, 4); assert.equal(bodyClosed, 4);
  } finally {
    global.fetch = realFetch;
    phase = 'HTTP server closure'; console.log(phase);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }

  // Real permission transitions during source work, for both list and replay.
  const original = await prisma.studyState.findUniqueOrThrow({ where: { uid } });
  for (const mode of ['list', 'replay']) {
    phase = 'permission '+mode; console.log(phase);
    let startedResolve, release;
    const started = new Promise(resolve => { startedResolve = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    global.fetch = async (url, options) => {
      if (String(url).endsWith('/tools/lookup') && sopUids.includes(options?.body)) { startedResolve(); await held; }
      return realFetch(url, options);
    };
    const response = assert.rejects(mode === 'list' ? service.list(uid, {}, caller) :
      service.write(uid, raw(commands[0]), caller), error => error.getStatus?.() === 403);
    await started;
    try {
      if (mode === 'list') await prisma.$executeRaw`UPDATE "StudyState" SET rs='P', "preDoc"='owned-other', "preReviewer"='owned-other' WHERE uid=${uid}`;
      else await prisma.$executeRaw`UPDATE "StudyState" SET "institutionId"=NULL, "teleInstitutionId"=NULL WHERE uid=${uid}`;
      release(); await response;
    } finally {
      release(); global.fetch = realFetch;
      const restored = mode === 'list' ?
        await prisma.$executeRaw`UPDATE "StudyState" SET rs=${original.rs}, "preDoc"=${original.preDoc}, "preReviewer"=${original.preReviewer} WHERE uid=${uid} AND rs='P' AND "preDoc"='owned-other' AND "preReviewer"='owned-other'` :
        await prisma.$executeRaw`UPDATE "StudyState" SET "institutionId"=${original.institutionId}, "teleInstitutionId"=${original.teleInstitutionId} WHERE uid=${uid} AND "institutionId" IS NULL AND "teleInstitutionId" IS NULL`;
      assert.equal(restored, 1);
      assert.deepEqual(await prisma.studyState.findUnique({ where: { uid } }), original);
    }
  }
  assert.deepEqual(await persisted(), baseline);
  console.log('READBACK PASS: real receipts/list, source faults, cancellation, permission and no duplicate writes');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  global.fetch = realFetch; await prisma.$disconnect(); clearTimeout(watchdog);
});
