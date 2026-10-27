const {StudyAccessService}=require('/app/dist/study-access.service');
// Real compiled services, Prisma and owned synthetic DICOM; injected delays
// affect only this separate test process, never the running API's transport.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaService } = require('/app/dist/prisma.service');
const { OrthancService } = require('/app/dist/orthanc.service');
const { ManualSrService } = require('/app/dist/manual-sr.service');
const prisma = new PrismaService(), orthanc = new OrthancService();
const { AccessLedgerStore } = require('/app/dist/emr-runtime/store');
const { FailureJournal, FailureSpool } = require('/app/dist/emr-runtime/failure-journal');
const { createRecordPort } = require('/app/dist/emr-runtime/record-port');
const { createStartupClinicalServices } = require('/app/dist/emr-clinical/startup');
const { FindingService } = require('/app/dist/finding.service');
const spool = new FailureSpool(require('node:path').join(require('node:os').tmpdir(), 'manual-sr-fault-' + randomUUID()));
const { port: records } = createRecordPort(new AccessLedgerStore(prisma, new FailureJournal(prisma, spool)));
const studyAccess = new StudyAccessService(prisma,orthanc,{});
const clinical = createStartupClinicalServices(prisma, records, {}, orthanc, studyAccess, new FindingService(prisma, studyAccess, orthanc));
const service = new ManualSrService(prisma, orthanc, studyAccess, clinical.manualSrSigning), realFetch = global.fetch;
let request;
const { uid, caller, items } = fixture;
const raw = x => Buffer.from(JSON.stringify(x));
let phase = 'setup';
const watchdog = setTimeout(() => { console.error('SR timeout at '+phase); process.exit(1); }, 55000);
const prepare = requestId => service.prepare(uid, raw({ requestId: requestId || randomUUID(), items }), caller);

async function run() {
  // Only admission facts are synthetic in this direct fault process. C2 reads
  // the same provisioned doctor key and B1 commits to the real fixture PG.
  const issuer = process.env.KC_ISSUER;
  const work = records.begin();
  let identityId;
  try { identityId = await work.resolveRequestIdentity(issuer, caller.sub); } finally { work.end(); }
  assert.ok(identityId);
  request = { facts: { actor: { id: identityId, issuer, subject: caller.sub },
    roles: caller.roles, institution: caller.institution, rightsVersion: 1, requestId: randomUUID(),
    ingress: { status: 'known', value: { address: '127.0.0.1', source: 'request-peer' } } },
    async requireCurrent(tx) {
      const member = await tx.memberRights.findUnique({ where: { sub: caller.sub } });
      assert.ok(member?.approved && !member.suspended && member.institution === caller.institution);
    } };
  const head = await prisma.viewerItem.findUniqueOrThrow({ where: { id: items[0].id } });
  const tags = await orthanc.viewerReference(head.snapshot.sopUid, true);
  assert.equal(tags.StudyInstanceUID, uid); assert.match(tags.PatientID, /^READBACK-/);
  const original = Buffer.from(await realFetch(process.env.ORTHANC_URL+'/instances/'+(await orthanc.viewerJson('/tools/lookup',head.snapshot.sopUid))[0].ID+'/file',
    { headers: { Authorization: orthanc.auth } }).then(r=>r.arrayBuffer()));

  phase = 'network outside clinical lock';
  const report = await prepare();
  let release, entered;
  const paused = new Promise(resolve => { release = resolve; }), entry = new Promise(resolve => { entered = resolve; });
  const realStore = orthanc.storeManualSr.bind(orthanc);
  orthanc.storeManualSr = async (...args) => { entered(); await paused; return realStore(...args); };
  const writing = service.store(uid, report.id, raw({}), caller, request);
  try {
    await entry;
    assert.ok((await prisma.manualSr.findUnique({ where: { id: report.id } })).attemptedAt);
    // NOWAIT fails immediately if the waiting Orthanc upload owns StudyState.
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT uid FROM "StudyState" WHERE uid = ${uid} FOR UPDATE NOWAIT`;
    });
  } finally { release(); }
  const stored = await writing; assert.equal(stored.stored, true); orthanc.storeManualSr = realStore;

  phase = 'temporary budget and expiry';
  const requestId = randomUUID(), expiring = await prepare(requestId);
  const count = await prisma.manualSr.count({ where: { studyUid: uid, attemptedAt: null, dicom: { not: null } } });
  for (let i = count; i < 32; i++) await prepare();
  await assert.rejects(prepare(), e => e.getStatus() === 409);
  await prisma.manualSr.updateMany({ where: { studyUid: uid, attemptedAt: null }, data: { createdAt: new Date(Date.now()-86401000) } });
  let resumeExpiry, enteredExpiry, delayExpiry = true;
  const expiryPause = new Promise(resolve => { resumeExpiry=resolve; }), expiryEntry = new Promise(resolve => { enteredExpiry=resolve; });
  prisma.$use(async (params, next) => {
    if (delayExpiry && params.model==='ManualSr' && params.action==='updateMany' && params.args?.data?.dicom===null) {
      delayExpiry=false; enteredExpiry(); await expiryPause;
    }
    return next(params);
  });
  const preparing = prepare();
  try {
    await expiryEntry;
    await prisma.$transaction(async tx => { await tx.$queryRaw`SELECT uid FROM "StudyState" WHERE uid = ${uid} FOR UPDATE NOWAIT`; });
  } finally { resumeExpiry(); }
  const next = await preparing; assert.notEqual(next.id, expiring.id);
  for (let i=0;i<4;i++) await service.expire(uid);
  const expired = await prisma.manualSr.findUniqueOrThrow({ where: { id: expiring.id } });
  assert.equal(expired.dicom, null); assert.equal(expired.dataset, null); assert.equal(expired.sha256, expiring.sha256);
  const expiration = await prisma.auditLog.findMany({ where: { target: uid, action: 'manualSr.expire' } });
  const expiredIds=expiration.flatMap(row=>JSON.parse(row.detail).ids);
  assert.equal(expiredIds.length,32); assert.equal(new Set(expiredIds).size,32); assert.ok(expiredIds.includes(expiring.id));
  assert.ok(expiration.every(row=>JSON.parse(row.detail).ids.length<=8));
  await assert.rejects(prepare(requestId), e => e.getStatus() === 410);
  await assert.rejects(service.store(uid, expiring.id, raw({}), caller, request), e => e.getStatus() === 410);
  assert.equal((await service.store(uid, report.id, raw({}), caller, request)).stored, true);
  assert.equal((await prisma.manualSr.findUnique({ where: { id: report.id } })).sha256, report.sha256);

  phase = 'failed maintenance does not reject a valid prepare';
  let failExpiry=true;
  prisma.$use(async (params,next) => {
    if (failExpiry && params.model==='ManualSr' && params.action==='updateMany' && params.args?.data?.dicom===null)
      throw new Error('synthetic maintenance failure');
    return next(params);
  });
  await prisma.manualSr.update({ where: { id: next.id }, data: { createdAt: new Date(Date.now()-86401000) } });
  const afterFailure=await prepare(); assert.ok(afterFailure.dicom);
  assert.ok((await prisma.manualSr.findUnique({ where: { id: next.id } })).dicom);
  assert.equal(await prisma.auditLog.count({ where: { target: uid, action: 'manualSr.expire-deferred' } }),1);
  failExpiry=false; await service.recoverPending();
  assert.equal((await prisma.manualSr.findUnique({ where: { id: next.id } })).dicom,null);

  phase = 'aggregate source deadline';
  let calls = 0, cancelled = 0;
  global.fetch = async (url, options) => {
    calls++;
    await new Promise((resolve, reject) => {
      const done = () => { options.signal.removeEventListener('abort', abort); resolve(); };
      const timer = setTimeout(done, 3900);
      const abort = () => { clearTimeout(timer); cancelled++; reject(new Error('synthetic source aborted')); };
      options.signal.addEventListener('abort', abort, { once: true });
      if (options.signal.aborted) abort();
    });
    return realFetch(url, options);
  };
  const before = await prisma.manualSr.count({ where: { studyUid: uid } }), start = Date.now();
  await assert.rejects(prepare(), e => e.getStatus() === 503);
  const elapsed = Date.now()-start;
  assert.ok(elapsed >= 9500 && elapsed < 12500, 'whole source deadline: '+elapsed);
  assert.equal(calls, 3); assert.equal(cancelled, 1);
  assert.equal(await prisma.manualSr.count({ where: { studyUid: uid } }), before);
  global.fetch = realFetch;
  assert.equal((await orthanc.viewerReference(head.snapshot.sopUid,true))._kinSourceDigest, tags._kinSourceDigest);
  assert.ok(original.length > 132);
  console.log('MANUAL SR FAULT PASS: actual upload outside parent lock; temporary quota/expiry/tombstone; stored retry; 10s aggregate deadline/cancel');
}
run().catch(error => { console.error(phase,error); process.exitCode=1; }).finally(async () => {
  global.fetch=realFetch; clearTimeout(watchdog); await spool.close(); await prisma.$disconnect();
});
