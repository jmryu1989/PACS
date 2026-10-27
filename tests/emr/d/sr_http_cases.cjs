'use strict';
// REQ-EMR-03/04/05/10 -> RISK-D-01..04 -> TEST-D-02/04: actual HTTP/PG
// manual SR authorization, retained signature, lost upload response and recovery.
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const path = require('node:path');
const api = process.env.KIN_D_API || path.resolve(__dirname, '../../../api');
const { ServiceUnavailableException } = require(path.join(api, 'node_modules/@nestjs/common'));
const { LedgerFailure } = require(path.join(api, 'dist/emr-runtime/store'));
const { OrthancService } = require(path.join(api, 'dist/orthanc.service'));

module.exports = async ({ db, orthanc, send, uid, members, records }) => {
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const tags = { StudyInstanceUID: uid, SeriesInstanceUID: uid + '.1', SOPInstanceUID: uid + '.1.1',
    SOPClassUID: '1.2.840.10008.5.1.4.1.1.2', FrameOfReferenceUID: uid + '.2', Modality: 'CT',
    PatientID: 'synthetic:' + uid, PatientName: 'SYNTHETIC^SR', Rows: 32, Columns: 32,
    ImagePositionPatient: [0, 0, 0], ImageOrientationPatient: [1, 0, 0, 0, 1, 0], PixelSpacing: [1, 1],
    _kinSourceDigest: 'a'.repeat(64) };
  const snapshot = { kind: 'length', studyUid: uid, seriesUid: tags.SeriesInstanceUID, sopUid: tags.SOPInstanceUID,
    frame: 1, frameOfReferenceUid: tags.FrameOfReferenceUID, sourceDigest: tags._kinSourceDigest,
    points: [[1, 1, 0], [4, 5, 0]], viewPlaneNormal: [0, 0, 1], viewUp: [0, 1, 0], baseline: { values: [5] }, label: '합성 길이' };
  const item = await db.viewerItem.create({ data: { id: randomUUID(), studyUid: uid, authorSub: members.doctor.sub,
    authorActor: 'doctor', revision: 1, snapshot, updatedAt: new Date() } });
  orthanc.viewerReference = async () => structuredClone(tags);
  assert.ok(process.env.KIN_D_SR_ORTHANC_URL, 'owned synthetic Orthanc fixture required');
  const priorEnvironment = { ORTHANC_URL: process.env.ORTHANC_URL, ORTHANC_USER: process.env.ORTHANC_USER, ORTHANC_PASS: process.env.ORTHANC_PASS };
  Object.assign(process.env, { ORTHANC_URL: process.env.KIN_D_SR_ORTHANC_URL, ORTHANC_USER: 'synthetic', ORTHANC_PASS: 'synthetic' });
  const source = new OrthancService();
  for (const [key, value] of Object.entries(priorEnvironment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  const archive = new Map(); let uploads = 0, loseAnswer = false, refuseUpload = false;
  orthanc.manualSrLocation = source.manualSrLocation.bind(source);
  orthanc.storeManualSr = async (sop, bytes) => {
    uploads++;
    if (refuseUpload) throw new ServiceUnavailableException('synthetic upload unavailable before storage');
    const id = await source.storeManualSr(sop, bytes);
    const readback = await fetch(process.env.KIN_D_SR_ORTHANC_URL + '/instances/' + id + '/file');
    assert.equal(readback.status, 200);
    assert.equal(digest(Buffer.from(await readback.arrayBuffer())), digest(bytes));
    archive.set(sop, { id, bytes: Buffer.from(bytes) });
    if (loseAnswer) throw new ServiceUnavailableException('synthetic upload response lost after storage');
    return archive.get(sop).id;
  };
  const prepare = () => send('doctor', 'POST', `/studies/${uid}/manual-sr`,
    { requestId: randomUUID(), items: [{ id: item.id, revision: 1 }] }, 200);
  const store = (sr, expected = 200, doctor = 'doctor') => send(doctor, 'POST', `/studies/${uid}/manual-sr/${sr.id}/store`, {}, expected);
  const versions = id => db.$queryRaw`SELECT outcome FROM emr_signing.signed_version WHERE record_id=${id}`;
  const entries = id => db.$queryRaw`SELECT e.payload::jsonb AS event, e.stream FROM emr_access.access_entry e
    WHERE e.payload::jsonb->'targets' @> ${JSON.stringify([{ kind: 'manual-sr', recordId: { status: 'known', value: id } }])}::jsonb`;

  const prepared = await prepare();
  assert.equal(prepared.stored, false);
  assert.equal(digest(Buffer.from(prepared.dicom, 'base64')), prepared.sha256);
  assert.equal((await store(prepared)).stored, true);
  const retained = await versions(prepared.id);
  assert.equal(retained.length, 1, 'author store intent retains one signed SR version');
  const approval = retained[0].outcome, plan = JSON.parse(approval.plan);
  assert.equal(plan.signing.content.sha256, prepared.sha256);
  assert.equal(plan.signing.content.sopInstanceUid, prepared.dataset.SOPInstanceUID);
  assert.equal(plan.signing.author.subject, members.doctor.sub);
  assert.equal(plan.signing.patient.patientId, tags.PatientID);
  assert.equal(approval.keyAtSigning.doctor.identity.subject, members.doctor.sub);
  assert.ok(approval.envelope);
  const recorded = await entries(prepared.id);
  assert.deepEqual(recorded.map(x => x.stream).sort(), ['history', 'viewing']);
  assert.ok(recorded.every(x => x.event.action === 'write' && x.event.targets[0].versionId.value === plan.adoption.versionId));
  assert.equal((await store(prepared)).stored, true);
  assert.equal(uploads, 1); assert.deepEqual(await versions(prepared.id), retained);
  assert.equal((await entries(prepared.id)).length, recorded.length);

  const pending = await prepare(); loseAnswer = true;
  await store(pending, 503); loseAnswer = false;
  const intent = await db.manualSr.findUnique({ where: { id: pending.id } });
  assert.ok(intent.attemptedAt); assert.equal(intent.storedAt, null);
  const pendingVersion = await versions(pending.id);
  assert.equal(pendingVersion.length, 1);
  assert.equal((await store(pending)).stored, true);
  assert.equal(uploads, 2, 'a lost answer must not upload or sign again');
  assert.deepEqual(await versions(pending.id), pendingVersion);

  const denied = await prepare();
  await store(denied, 403, 'other');
  assert.equal((await versions(denied.id)).length, 0);
  assert.equal((await db.manualSr.findUnique({ where: { id: denied.id } })).attemptedAt, null);

  // PG rejects the ledger append: signature, intent and audit must all roll
  // back and Orthanc must not receive a document. A retry reuses the SR file.
  await db.$executeRawUnsafe(`ALTER TABLE emr_access.access_entry ADD CONSTRAINT synthetic_sr_failure
    CHECK (payload::jsonb->>'surface' <> 'POST studies/:uid/manual-sr/:id/store') NOT VALID`);
  await store(denied, 503);
  await db.$executeRawUnsafe('ALTER TABLE emr_access.access_entry DROP CONSTRAINT synthetic_sr_failure');
  assert.equal((await versions(denied.id)).length, 0);
  assert.equal((await db.manualSr.findUnique({ where: { id: denied.id } })).attemptedAt, null);
  assert.equal(await db.auditLog.count({ where: { action: 'manualSr.store-intent', detail: { contains: denied.id } } }), 0);
  assert.equal(uploads, 2);
  assert.equal((await store(denied)).stored, true);

  // Lose the B1 reply after its real commit. The HTTP caller gets the same
  // retryable 503, and the next request observes the already signed intent.
  const unknown = await prepare(), beforeUnknownUploads = uploads;
  const begin = records.begin;
  records.begin = () => {
    const work = begin(), transaction = work.transactionWithRecords;
    work.transactionWithRecords = async (...args) => {
      await transaction(...args);
      throw new LedgerFailure('CommitUnknown');
    };
    return work;
  };
  try { await store(unknown, 503); } finally { records.begin = begin; }
  const unknownVersion = await versions(unknown.id);
  assert.equal(unknownVersion.length, 1);
  assert.ok((await db.manualSr.findUnique({ where: { id: unknown.id } })).attemptedAt);
  assert.equal(uploads, beforeUnknownUploads);
  assert.equal((await store(unknown)).stored, true);
  assert.deepEqual(await versions(unknown.id), unknownVersion);

  // An accepted intent survives later measurement edits; retry uploads its
  // exact retained file, without demanding another signature or preparation.
  const retry = await prepare(); refuseUpload = true;
  await store(retry, 503); refuseUpload = false;
  const retryVersion = await versions(retry.id);
  await db.viewerItem.update({ where: { id: item.id }, data: { revision: 2 } });
  assert.equal((await store(retry)).stored, true);
  assert.deepEqual(await versions(retry.id), retryVersion);
  assert.equal(digest(archive.get(retry.dataset.SOPInstanceUID).bytes), retry.sha256);
  await db.viewerItem.update({ where: { id: item.id }, data: { revision: 1 } });

  // No source disappearance is silently presented as an adopted document.
  const storedBytes = archive.get(retry.dataset.SOPInstanceUID);
  assert.equal(await source.manualSrLocation(retry.dataset.SOPInstanceUID, storedBytes.bytes), storedBytes.id);
  const removed = await fetch(process.env.KIN_D_SR_ORTHANC_URL + '/instances/' + storedBytes.id, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  await store(retry, 409);
  assert.deepEqual(await versions(retry.id), retryVersion);
  await source.storeManualSr(retry.dataset.SOPInstanceUID, storedBytes.bytes);

  // A key failure is atomic as well. Existing authorizations still recover
  // using their retained public registration, never the current private key.
  const noKey = await prepare(), pendingBackground = await prepare();
  loseAnswer = true; await store(pendingBackground, 503); loseAnswer = false;
  const beforeRecovery = await versions(pendingBackground.id), beforeUploads = uploads;
  await db.$executeRaw`UPDATE emr_signing.doctor_key SET status='suspended'
    WHERE kid=${approval.kid}`;
  await store(noKey, 503);
  assert.equal((await versions(noKey.id)).length, 0);
  assert.equal((await db.manualSr.findUnique({ where: { id: noKey.id } })).attemptedAt, null);
  await db.memberRights.update({ where: { sub: members.doctor.sub }, data: { suspended: true } });
  await db.manualSr.update({ where: { id: pendingBackground.id }, data: { nextCheckAt: new Date() } });
  // Exercise the serving provider's real timer. Its existing cadence is 15s;
  // allow one tick and the existing 8s SR transaction timeout to finish.
  const until = Date.now() + 15000 + 8000;
  let recovered;
  do {
    recovered = await db.manualSr.findUnique({ where: { id: pendingBackground.id } });
    if (recovered.storedAt) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < until);
  assert.ok(recovered.storedAt, 'background reconciliation finishes a committed author intent after access is withdrawn');
  assert.equal(uploads, beforeUploads);
  assert.deepEqual(await versions(pendingBackground.id), beforeRecovery);
  await store(pendingBackground, 401);
  await db.memberRights.update({ where: { sub: members.doctor.sub }, data: { suspended: false } });
  await db.$executeRaw`UPDATE emr_signing.doctor_key SET status='active' WHERE kid=${approval.kid}`;

  // The source patient is read at Orthanc before the study and SR rows are
  // locked, so the archive's answer time never holds clinical work.
  const identities = orthanc.studyIdentityResources, lockFree = [];
  const free = async query => { try { await query; return true; } catch { return false; } };
  const observedSr = await prepare();
  orthanc.studyIdentityResources = async id => {
    if (id === uid) lockFree.push(await free(db.$queryRaw`SELECT uid FROM "StudyState" WHERE uid=${uid} FOR UPDATE NOWAIT`) &&
      await free(db.$queryRaw`SELECT id FROM "ManualSr" WHERE id=${observedSr.id}::uuid FOR UPDATE NOWAIT`));
    return identities.call(orthanc, id);
  };
  try { assert.equal((await store(observedSr)).stored, true); } finally { orthanc.studyIdentityResources = identities; }
  assert.ok(lockFree.length > 0 && lockFree.every(Boolean), 'no Orthanc identity read while the SR store holds its locks');

  // Another patient now answers for the study: a permanent, mapped refusal
  // that signs nothing and records no intent.
  const moved = await prepare(), movedUploads = uploads;
  orthanc.studyIdentityResources = async id => id === uid
    ? [{ '0020000D': { Value: [uid] }, '00100020': { Value: ['synthetic:other-patient'] } }] : identities.call(orthanc, id);
  try { assert.equal((await store(moved, 409)).code, 'ManualSrPatientChanged'); } finally { orthanc.studyIdentityResources = identities; }
  assert.equal((await versions(moved.id)).length, 0);
  assert.equal((await db.manualSr.findUnique({ where: { id: moved.id } })).attemptedAt, null);
  assert.equal(uploads, movedUploads);

  // A retained approval whose signed content is not the row's bytes is refused
  // permanently: here the row and its unsigned adoption are both moved to other
  // bytes while the signed half still names the original document.
  const swapped = await prepare();
  loseAnswer = true; await store(swapped, 503); loseAnswer = false;
  const swappedUploads = uploads, otherBytes = Buffer.concat([Buffer.from(swapped.dicom, 'base64'), Buffer.alloc(2)]);
  const approvalOf = async id => (await db.$queryRaw`SELECT outcome FROM emr_signing.operation WHERE outcome->>'recordId'=${id}`)[0].outcome;
  const swappedPlan = JSON.parse((await approvalOf(swapped.id)).plan);
  swappedPlan.adoption.bytesSha256 = digest(otherBytes);
  await db.$executeRaw`UPDATE emr_signing.operation SET outcome=jsonb_set(outcome, '{plan}', to_jsonb(${JSON.stringify(swappedPlan)}::text))
    WHERE outcome->>'recordId'=${swapped.id}`;
  await db.manualSr.update({ where: { id: swapped.id }, data: { dicom: otherBytes, sha256: digest(otherBytes) } });
  const refused = await store(swapped, 409);
  assert.equal(refused.code, 'ManualSrAuthorizationConflict');
  assert.doesNotMatch(refused.message, /다시 시도|다시 확인/, 'a permanent refusal does not ask for the same request again');
  assert.equal(uploads, swappedUploads);
  // The background loop stops rescheduling the row instead of retrying it
  // every interval; the committed intent and its signature stay as they were.
  const swappedVersions = await versions(swapped.id);
  await db.manualSr.update({ where: { id: swapped.id }, data: { nextCheckAt: new Date() } });
  const stopBy = Date.now() + 15000 + 8000;
  let stopped;
  do {
    stopped = await db.manualSr.findUnique({ where: { id: swapped.id } });
    if (stopped.nextCheckAt === null) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < stopBy);
  assert.equal(stopped.nextCheckAt, null, 'a permanently refused row leaves the background schedule');
  assert.equal(stopped.storedAt, null); assert.ok(stopped.attemptedAt);
  assert.equal(uploads, swappedUploads);
  assert.deepEqual(await versions(swapped.id), swappedVersions);

  // A stored SR whose approval is missing answers a mapped refusal, never 500.
  const [kept] = await db.$queryRaw`SELECT operation_id, outcome FROM emr_signing.operation WHERE outcome->>'recordId'=${prepared.id}`;
  await db.$executeRaw`UPDATE emr_signing.operation SET outcome=NULL WHERE operation_id=${kept.operation_id}`;
  try { assert.equal((await store(prepared, 409)).code, 'ManualSrAuthorizationUnavailable'); } finally {
    await db.$executeRaw`UPDATE emr_signing.operation SET outcome=${JSON.stringify(kept.outcome)}::jsonb WHERE operation_id=${kept.operation_id}`;
  }
  assert.equal((await store(prepared)).stored, true);
};
