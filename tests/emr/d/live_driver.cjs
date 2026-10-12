/* EMR-D round 2 live driver: one scenario of the compiled product inside the production API image of this checkout.
 *
 * tests/emr/d/live.py (EmrDLive, run only through scripts/run-tests.py) starts it with `node /emr-d/live_driver.cjs
 * <operation> <json>` beside a disposable PostgreSQL whose migrations the same image applied. The six owning services, the
 * D runtime/store/signature port, B1's ledger store and C's v2 verifier are the image's own /app/dist; what the not-yet
 * landed units would supply at server start is stood in here, in this file only: B2's verified context (fixed synthetic
 * people whose immutable identities B1 resolves), C's study reader (a synthetic patient link per study) and C's key and
 * anchor readers (tests/emr/d/device.cjs, explicit test key policy). Keycloak and Orthanc are recording stand-ins. The
 * driver prints exactly one line `EMR_D_RESULT <json>` with the services' answers; the Python case reads the stored facts
 * itself. With KIN_EMR_D_MUTANT (one {file, old, new} of /app/dist) the scenario runs against a copy of the compiled code
 * with that one change (an anchor not found exactly once is reported, never run).
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const send = result => process.stdout.write('EMR_D_RESULT ' + JSON.stringify(result) + '\n', () => process.exit(0));
const describe = error => ({ status: typeof error?.getStatus === 'function' ? error.getStatus() : null,
  code: (typeof error?.getResponse === 'function' ? error.getResponse()?.code : null) ?? error?.code ?? null,
  name: error?.name ?? null, message: String(error?.message ?? error).slice(0, 400) });
// Only `node live_driver.cjs <operation> <json>` runs a scenario; loaded any other way (a test runner's glob) it does nothing.
if (require.main === module && process.argv.length > 2)
  main().then(send, error => send({ crashed: describe(error), stack: String(error?.stack ?? '').slice(0, 1500) }));

const ISSUER = 'https://identity.example.test/realms/synthetic';
const PEOPLE = {
  c1: { sub: 'c1000000-0000-4000-8000-000000000001', roles: ['clinician'], institution: 'inst-a', sign: true },
  c2: { sub: 'c2000000-0000-4000-8000-000000000002', roles: ['clinician'], institution: 'inst-a', sign: true },
  r1: { sub: 'a1000000-0000-4000-8000-000000000001', roles: ['radiologist'], institution: 'inst-a', sign: true },
  r2: { sub: 'a2000000-0000-4000-8000-000000000002', roles: ['radiologist'], institution: 'inst-a', sign: true },
  t1: { sub: 'b1000000-0000-4000-8000-000000000001', roles: ['technician'], institution: 'inst-a', sign: false },
  ad: { sub: 'd1000000-0000-4000-8000-000000000001', roles: ['admin'], institution: 'inst-a', sign: false },
  rb: { sub: 'e1000000-0000-4000-8000-000000000001', roles: ['radiologist'], institution: 'inst-b', sign: true },
};
const TEXT = {
  question: 'SYN 흉통 지속\r\n이전 CT와 비교 바랍니다 é ', answer: 'SYN 이전 CT 대비 변화 없음.', followup: 'SYN 추가 질문: 조영 증강 여부',
  request: 'SYN 외부 병원 영상 요청 사유', close: 'SYN 외부 영상 수신 처리 완료 기록', consult: 'SYN 자문 의뢰: 결절 성상', reply: 'SYN 자문 답변: 양성 소견',
};
const uuid = () => crypto.randomUUID();
const known = value => ({ status: 'known', value });

async function main() {
  const [operation, raw] = process.argv.slice(2);
  const args = raw ? JSON.parse(raw) : {};
  let dist = '/app/dist';
  if (process.env.KIN_EMR_D_MUTANT) {
    const mutant = JSON.parse(process.env.KIN_EMR_D_MUTANT);
    const copy = fs.mkdtempSync('/tmp/kin-emr-d-mutant-');
    fs.cpSync(dist, copy, { recursive: true });
    const file = path.join(copy, mutant.file), text = fs.readFileSync(file, 'utf8');
    const count = text.split(mutant.old).length - 1;
    if (count !== 1) return { mutantAnchor: { file: mutant.file, count } };
    fs.writeFileSync(file, text.replace(mutant.old, mutant.new));
    dist = copy;
  }
  const req = name => require(path.join(dist, name));
  require('/app/node_modules/reflect-metadata');
  req('emr-contract/composition').composeEmrAdapters(req('emr-runtime/context').runtimeAdapters);
  const RTS = req('emr-runtime/store'), { FailureJournal } = req('emr-runtime/failure-journal'), { AccessSeal } = req('emr-runtime/seal');
  const { EmrLedgerClient } = req('emr-runtime/client'), { appendPoolConfiguration } = req('emr-runtime/admission');
  const K = req('emr-signature/keys'), CV = req('emr-signature/canonical-v2');
  const R = req('emr-clinical/records'), CT = req('emr-clinical/contract'), RT = req('emr-clinical/runtime'), SV = req('emr-clinical/services');
  const { PrismaService } = req('prisma.service'), { StudyAccessService } = req('study-access.service');
  const { copySource } = req('finding-input'), { canonical } = req('viewer-input');
  const STATE = process.env.KIN_EMR_STATE_DIR;

  const pool = appendPoolConfiguration(process.env.DATABASE_URL);
  const ledgerDb = new EmrLedgerClient(pool.url);
  const prisma = new PrismaService();
  await ledgerDb.$connect(); await prisma.$connect();
  const sql = new RTS.PrismaLedgerSql(ledgerDb), journal = new FailureJournal(STATE), seal = new AccessSeal(STATE, sql, journal);
  await seal.recoverAtStart();
  const ledger = new RTS.AccessLedgerStore(ledgerDb, sql, seal, journal, pool.poolSize);

  // ---- the synthetic people (B2 stand-in) and their device keys (C stand-in) ----
  const ids = new Map();
  async function identityOf(subject) {
    if (!ids.has(subject)) ids.set(subject, await ledgerDb.$transaction(tx => ledger.resolveIdentity(tx, ISSUER, subject)));
    return { id: ids.get(subject), issuer: ISSUER, subject };
  }
  const nameOf = subject => Object.keys(PEOPLE).find(n => PEOPLE[n].sub === subject);
  async function actorFacts(name) {
    const p = PEOPLE[name];
    return { identity: await identityOf(p.sub), kind: 'member', roles: [...p.roles], institutionId: p.institution, signingRegistrationId: p.sign ? 'reg-' + name : null };
  }
  const caller = name => ({ kind: 'member', institution: PEOPLE[name].institution, sub: PEOPLE[name].sub, actor: name + '@synthetic.test',
    roles: [...PEOPLE[name].roles], name: 'SYN ' + name });
  const owner = name => [PEOPLE[name].institution, PEOPLE[name].sub];
  const dev = require('./device.cjs')({ K, CV });
  const saved = path.join('/work', 'device.json');
  if (fs.existsSync(saved)) dev.restore(JSON.parse(fs.readFileSync(saved, 'utf8')));
  else {
    for (const [name, p] of Object.entries(PEOPLE)) if (p.sign)
      dev.register(await identityOf(p.sub), 'reg-' + name, p.institution, { kid: 'kid-' + name, deviceId: 'dev-' + name, osUserId: 'os-' + name });
  }
  const studies = { facts: async (db, studyId) => {
    const rows = await db.$queryRaw`SELECT "institutionId" FROM "StudyState" WHERE uid = ${studyId}`;
    if (!rows.length || !rows[0].institutionId) throw Object.assign(new Error('synthetic study unknown'), { code: 'NotFound' });
    return { studyId, managingInstitutionId: rows[0].institutionId, patient: { linkId: 'link-' + studyId, patientId: 'SYN-PATIENT-1', assigningAuthority: rows[0].institutionId } };
  } };
  const context = { facts: async request => ({ actor: request.actor, trustedProxyIp: known({ address: '192.0.2.10', source: 'trusted-proxy' }),
    requestId: 'request-' + uuid(), member: identityOf, signature: request.signature ?? null }) };
  const runtime = RT.composeClinicalRuntime({ db: ledgerDb, ledger, context, studies, signatures: dev.ports, recoveryDelayMs: 200 });

  // ---- recording stand-ins for the identity provider and the image server ----
  const keycloak = {
    async getUser(sub) {
      const name = nameOf(sub); if (!name) return null;
      return { id: sub, enabled: true, serviceAccountClientId: null, groups: [PEOPLE[name].institution], roles: [...PEOPLE[name].roles],
        email: name + '@synthetic.test', username: name, firstName: 'SYN', lastName: name };
    },
    async assignmentReaders() { return []; },
  };
  const orthancStored = new Map(), orthancFailing = new Set(args.orthancFailing ?? []);
  for (const [sop, hex] of Object.entries(args.orthancHolds ?? {})) orthancStored.set(sop, Buffer.from(hex, 'hex'));
  const md5 = bytes => crypto.createHash('md5').update(bytes).digest('hex');
  const common = require('/app/node_modules/@nestjs/common');
  const orthanc = {
    async viewerReference(sop) { return args.tags?.[sop] ?? null; },
    async manualSrLocation(sop, bytes) {
      const stored = orthancStored.get(sop); if (!stored) return null;
      if (md5(stored) !== md5(bytes)) throw new common.BadRequestException('동일 SR 식별자의 원문이 다릅니다');
      return md5(stored).slice(0, 8) + '-00000000-00000000-00000000-00000000';
    },
    async storeManualSr(sop, bytes) {
      if (orthancFailing.has(sop)) throw new common.ServiceUnavailableException('SR 저장 결과를 확인할 수 없습니다');
      orthancStored.set(sop, Buffer.from(bytes)); return this.manualSrLocation(sop, bytes);
    },
  };
  const access = new StudyAccessService(prisma, orthanc, keycloak);
  const S = {
    questions: new (req('clinician-question.service').ClinicianQuestionService)(prisma, access),
    requests: new (req('image-request.service').ImageRequestService)(prisma, access),
    consultations: new (req('consultation.service').ConsultationService)(prisma, keycloak, access),
    findings: new (req('finding.service').FindingService)(prisma, access, orthanc),
    srs: new (req('manual-sr.service').ManualSrService)(prisma, orthanc, access),
    assignments: new (req('reader-assignment.service').ReaderAssignmentService)(prisma, keycloak, access),
  };

  /** What the author's device signs for one write: the signing request records.ts plans for exactly these facts. */
  async function request(name, surface, recordId, body, { studyId, content = null, navigation = [], recipientSub = null, readerSub = null,
    reading = null, change = null, signWith = null, kid = null, unsigned = false } = {}) {
    const actor = await actorFacts(name);
    if (unsigned || !PEOPLE[name].sign) return { actor, signature: null };
    const spec = CT.CLINICAL_SURFACES[surface], study = await studies.facts(prisma, studyId), unit = await runtime.store.unit(recordId);
    const recipientId = recipientSub && spec.record === 'consultation' && !unit ? (await identityOf(recipientSub)).id : null;
    const readerId = spec.record === 'assignment' && readerSub ? (await identityOf(readerSub)).id : null;
    let plan;
    // A write the server will refuse has no plan to sign: the device sends nothing and the server answers the refusal.
    try { plan = R.planClinicalWrite({ surface, actor, study, unit, body, content, attachments: [], navigation, recipientId, readerId,
      workContext: reading ? { kind: 'reading', studyId, referenceId: reading } : null, ids: { recordId, versionId: uuid() }, at: new Date().toISOString() }); }
    catch { return { actor, signature: null }; }
    if (!plan.signing) return { actor, signature: null };
    const signed = dev.sign(plan.signing, { kid: kid ?? 'kid-' + name, eventId: String(body[spec.requestField ?? 'requestId']).toLowerCase(), change,
      signWith: signWith ?? kid ?? 'kid-' + name });
    return { actor, signature: signed };
  }
  const attempt = async work => { try { return { ok: true, value: await work() }; } catch (error) { return { ok: false, error: describe(error) }; } };
  /** The canonical snapshot a finding write stores and signs, from the stored item heads (finding-input copySource). */
  async function findingText(uid, item, sources) {
    const copies = [];
    for (const ref of sources) {
      const [row] = await prisma.$queryRaw`SELECT id, "studyUid", revision, hidden, "authorActor", snapshot::text AS snapshot FROM "ViewerItem" WHERE id = ${ref.itemId}::uuid`;
      copies.push(copySource({ ...row, snapshot: JSON.parse(row.snapshot) }));
    }
    return canonical({ schemaVersion: 1, title: item.title, text: item.text, hidden: item.hidden ?? false, primary: item.primary ?? 0, sources: copies });
  }
  const body = value => Buffer.from(JSON.stringify(value));

  try {
    const scenario = SCENARIOS[operation];
    if (!scenario) return { crashed: { code: 'UnknownOperation' } };
    const result = await scenario({ args, S, R, SV, req, studies, runtime, request, attempt, caller, owner, actorFacts, identityOf, findingText, body, PEOPLE,
      TEXT, dev, ledger, seal, STATE, prisma, ledgerDb, orthancStored });
    fs.writeFileSync(saved, JSON.stringify(dev.save()));
    return result;
  } finally {
    runtime.stop();
    await prisma.$disconnect(); await ledgerDb.$disconnect();
  }
}

const SCENARIOS = {
  /** TEST-D-01: clinical entries are signed versions of their own authors; operational steps are unsigned versions. */
  async d01({ args, S, request, attempt, caller, owner, actorFacts, PEOPLE, TEXT }) {
    const uid = args.study, out = {};
    const q = { requestId: uuid(), expectedOwner: owner('c1'), body: TEXT.question }, qid = q.requestId.toLowerCase();
    out.question = await attempt(async () => S.questions.create(uid, caller('c1'), q, await request('c1', 'question.create', qid, q, { studyId: uid })));
    const a = { requestId: uuid(), expectedOwner: owner('r1'), revision: 1, body: TEXT.answer };
    out.answer = await attempt(async () => S.questions.reply(qid, caller('r1'), a, await request('r1', 'question.reply', qid, a, { studyId: uid })));
    const u = { requestId: uuid(), expectedOwner: owner('c1'), body: 'SYN unsigned question' };
    out.unsigned = await attempt(async () => S.questions.create(uid, caller('c1'), u, await request('c1', 'question.create', u.requestId, u, { studyId: uid, unsigned: true })));
    // r1's key signs a question authored by c1 (a proxy signature).
    const p = { requestId: uuid(), expectedOwner: owner('c1'), body: 'SYN proxy-signed question' };
    out.proxy = await attempt(async () => {
      const r1 = await actorFacts('r1');
      const signed = await request('c1', 'question.create', p.requestId, p, { studyId: uid, kid: 'kid-r1',
        change: x => ({ ...x, signer: { ...r1.identity }, identityRegistrationId: 'reg-r1' }) });
      return S.questions.create(uid, caller('c1'), p, signed);
    });
    const as = { requestId: uuid(), expectedOwner: owner('t1'), revision: 0, readerSub: PEOPLE.r1.sub };
    out.assignment = await attempt(async () => S.assignments.write(uid, caller('t1'), as, await request('t1', 'assignment.write', '', as, { studyId: uid })));
    const ir = { requestId: uuid(), expectedOwner: owner('c1'), kind: 'external-image', counterparty: 'SYN 외부병원', counterpartyInstitutionId: null,
      reason: TEXT.request }, irid = ir.requestId.toLowerCase();
    out.imageRequest = await attempt(async () => S.requests.create(uid, caller('c1'), ir, await request('c1', 'image-request.create', irid, ir, { studyId: uid })));
    const accept = { requestId: uuid(), expectedOwner: owner('t1'), revision: 1, action: 'accept', note: '' };
    out.accept = await attempt(async () => S.requests.change(irid, caller('t1'), accept, await request('t1', 'image-request.accept', irid, accept, { studyId: uid })));
    const close = { requestId: uuid(), expectedOwner: owner('t1'), revision: 2, action: 'close', note: TEXT.close };
    out.close = await attempt(async () => S.requests.change(irid, caller('t1'), close, await request('t1', 'image-request.close', irid, close, { studyId: uid })));
    out.ids = { question: qid, unsigned: u.requestId.toLowerCase(), proxy: p.requestId.toLowerCase(), imageRequest: irid };
    return out;
  },

  /** TEST-D-02: every change is an exact version; a legacy overwrite never loses the earlier text; SR adoption and clean-up. */
  async d02({ args, S, request, attempt, caller, owner, findingText, body, TEXT, prisma }) {
    const uid = args.study, out = {};
    // consultation: r1 asks r2; r2 accepts; r2 answers.
    const cr = { requestId: uuid(), expectedOwner: owner('r1'), recipientSub: args.recipientSub, reason: TEXT.consult }, cid = cr.requestId.toLowerCase();
    out.consult = await attempt(async () => S.consultations.create(uid, caller('r1'), cr, await request('r1', 'consultation.create', cid, cr, { studyId: uid, recipientSub: args.recipientSub })));
    const acc = { requestId: uuid(), expectedOwner: owner('r2'), revision: 1, action: 'accept', note: '' };
    out.consultAccept = await attempt(async () => S.consultations.change(cid, caller('r2'), acc, await request('r2', 'consultation.accept', cid, acc, { studyId: uid })));
    const done = { requestId: uuid(), expectedOwner: owner('r2'), revision: 2, action: 'complete', note: TEXT.reply };
    out.consultComplete = await attempt(async () => S.consultations.change(cid, caller('r2'), done, await request('r2', 'consultation.complete', cid, done, { studyId: uid })));
    // image request: the clinician's reason, then the technician's two processing steps.
    const ir = { requestId: uuid(), expectedOwner: owner('c1'), kind: 'image-transfer', counterparty: 'SYN 협력병원', counterpartyInstitutionId: null,
      reason: TEXT.request }, irid = ir.requestId.toLowerCase();
    out.imageRequest = await attempt(async () => S.requests.create(uid, caller('c1'), ir, await request('c1', 'image-request.create', irid, ir, { studyId: uid })));
    const decline = { requestId: uuid(), expectedOwner: owner('t1'), revision: 1, action: 'decline', note: TEXT.close };
    out.decline = await attempt(async () => S.requests.change(irid, caller('t1'), decline, await request('t1', 'image-request.decline', irid, decline, { studyId: uid })));
    // finding: create, then hide inside the author's reading (no typed reason), then restore with a stated reason.
    const item = { schemaVersion: 1, title: 'SYN 결절', text: 'SYN 우상엽 8 mm 결절', sources: [{ itemId: args.itemId, revision: 1 }] };
    const fc = { requestId: uuid(), item }, fid = uuid();
    out.finding = await attempt(async () => {
      return S.findings.write(uid, body(fc), caller('r1'), undefined,
        await request('r1', 'finding.create', fid, fc, { studyId: uid, content: await findingText(uid, item, item.sources) }));
    });
    const created = out.finding.ok ? out.finding.value.id : null;
    if (created) {
      await prisma.$executeRaw`UPDATE "StudyState" SET holder = ${'r1@synthetic.test'}, "heldAt" = now() WHERE uid = ${uid}`;
      const [state] = await prisma.$queryRaw`SELECT "draftEpoch"::text AS epoch FROM "StudyState" WHERE uid = ${uid}`;
      const hide = { requestId: uuid(), expectedRevision: 1, action: 'hide', item };
      out.hide = await attempt(async () => S.findings.write(uid, body(hide), caller('r1'), created, await request('r1', 'finding.hide', created, hide,
        { studyId: uid, content: await findingText(uid, { ...item, hidden: true }, item.sources), reading: 'hold:' + state.epoch })));
      await prisma.$executeRaw`UPDATE "StudyState" SET holder = NULL, "heldAt" = NULL WHERE uid = ${uid}`;
      const restore = { requestId: uuid(), expectedRevision: 2, action: 'restore', item, reason: 'SYN 오기재 복원' };
      out.restore = await attempt(async () => S.findings.write(uid, body(restore), caller('r1'), created, await request('r1', 'finding.restore', created, restore,
        { studyId: uid, content: await findingText(uid, item, item.sources) })));
      const noReason = { requestId: uuid(), expectedRevision: 3, action: 'hide', item };
      out.hideOutOfContext = await attempt(async () => S.findings.write(uid, body(noReason), caller('r1'), created, await request('r1', 'finding.hide', created, noReason,
        { studyId: uid, content: await findingText(uid, { ...item, hidden: true }, item.sources) })));
    }
    out.ids = { consultation: cid, imageRequest: irid, finding: created };
    return out;
  },

  /** TEST-D-02 SR: signed adoption of exact bytes, upload, and the 24-hour clean-up that ends only an unclaimed copy. */
  async 'd02-sr'({ args, S, R, studies, attempt, caller, actorFacts, dev, prisma }) {
    const uid = args.study, out = {};
    async function adopt(id) {
      const [row] = await prisma.$queryRaw`SELECT sha256, dataset->>'SOPInstanceUID' AS sop, "createdAt" FROM "ManualSr" WHERE id = ${id}::uuid`;
      const actor = await actorFacts('r1');
      const sr = { id, studyId: uid, authorId: actor.identity.id, createdAt: row.createdAt.toISOString(), attemptedAt: null, storedAt: null, bytesSha256: row.sha256,
        sopInstanceUid: row.sop, adoptedVersion: null, referencedBy: [], holdIds: [], orthanc: 'unknown' };
      const plan = R.planManualSrAdoption({ actor, study: await studies.facts(prisma, uid), sr, versionId: uuid(), at: new Date().toISOString() });
      return { actor, signature: dev.sign(plan.signing, { kid: 'kid-r1', eventId: id }) };
    }
    for (const id of args.adopt) out['store:' + id] = await attempt(async () => S.srs.store(uid, id, Buffer.from('{}'), caller('r1'), await adopt(id)));
    out.unsignedStore = await attempt(async () => S.srs.store(uid, args.unsigned, Buffer.from('{}'), caller('r1'), { actor: await actorFacts('r1'), signature: null }));
    return out;
  },
  /** The 24-hour clean-up through the service's own background tick (onModuleInit), after the copies were backdated. */
  async 'd02-sweep'({ S }) {
    S.srs.onModuleInit();
    await new Promise(resolve => setTimeout(resolve, 17000));
    S.srs.onModuleDestroy();
    return { swept: true };
  },
  /** A new process re-reads the adopted SR: the stored bytes still hash to what the author signed, and the signature verifies. */
  async 'd02-reread'({ args, runtime, prisma, dev, req }) {
    const out = {};
    const verify = req('emr-signature/verify');
    for (const id of args.ids) {
      const adoption = await runtime.srAdoption(id);
      const [row] = await prisma.$queryRaw`SELECT dicom, sha256, "storedAt" FROM "ManualSr" WHERE id = ${id}::uuid`;
      const stored = await prisma.$queryRaw`SELECT signature FROM emr_clinical.sr_adoption_for(${id}::text)`;
      const signature = JSON.parse(stored[0].signature);
      let verified = null;
      try { const v = verify.verifySignatureV2(signature.envelope.jws, dev.ports, { osUserId: signature.envelope.osUserId });
        verified = { integrity: v.integrity, key: v.keyAtSigningTime, text: v.payload.text.body }; } catch (e) { verified = describe(e); }
      out[id] = { adoption, bytesSha256: crypto.createHash('sha256').update(row.dicom).digest('hex'), rowSha256: row.sha256, stored: !!row.storedAt, verified };
    }
    return out;
  },

  /** TEST-D-03: bodies only to permitted readers of the managing institution, after the durable access event. */
  async d03({ args, S, SV, runtime, request, attempt, caller, owner, actorFacts, TEXT, prisma }) {
    const uid = args.study, out = {};
    const q = { requestId: uuid(), expectedOwner: owner('c1'), body: TEXT.question }, qid = q.requestId.toLowerCase();
    out.question = await attempt(async () => S.questions.create(uid, caller('c1'), q, await request('c1', 'question.create', qid, q, { studyId: uid })));
    const a = { requestId: uuid(), expectedOwner: owner('r1'), revision: 1, body: TEXT.answer };
    out.answer = await attempt(async () => S.questions.reply(qid, caller('r1'), a, await request('r1', 'question.reply', qid, a, { studyId: uid })));
    for (const name of ['c1', 'r1', 'c2', 'rb', 'ad'])
      out['read:' + name] = await attempt(async () => S.questions.read(qid, caller(name), { actor: await actorFacts(name), signature: null }));
    // The runtime boundary itself (any caller, not only the six services): another institution's verified reader.
    out.runtimeForeign = await attempt(async () => runtime.read({ actor: await actorFacts('rb'), signature: null }, { record: 'question', recordId: qid,
      scope: 'history', rows: await SV.readClinicalRows(prisma, qid), caller: { subject: (await actorFacts('rb')).identity.subject, institutionId: 'inst-b' },
      send: async () => 'SYN BODY' }));
    // Rows that did not come from readClinicalRows are refused even for a reader the boundary would admit.
    out.runtimeForged = await attempt(async () => runtime.read({ actor: await actorFacts('r1'), signature: null }, { record: 'question', recordId: qid,
      scope: 'history', rows: JSON.parse(JSON.stringify(await SV.readClinicalRows(prisma, qid))), caller: { subject: (await actorFacts('r1')).identity.subject,
        institutionId: 'inst-a' }, send: async () => 'SYN BODY' }));
    out.ids = { question: qid };
    return out;
  },
  /** TEST-D-03: with the ledger's external seal unwritable the access record is not durable and no body is handed out. */
  async 'd03-ledger-down'({ args, S, attempt, caller, actorFacts, STATE }) {
    const tail = path.join(STATE, 'seal', 'tail.json');
    fs.chmodSync(tail, 0o400);
    try { return { read: await attempt(async () => S.questions.read(args.question, caller('c1'), { actor: await actorFacts('c1'), signature: null })) }; }
    finally { fs.chmodSync(tail, 0o600); }
  },

  /** TEST-D-04: one commit per request, replays answer the stored receipt, every failure commits nothing and keeps the input. */
  async d04({ args, S, request, attempt, caller, owner, TEXT, prisma }) {
    const uid = args.study, out = {};
    const q = { requestId: uuid(), expectedOwner: owner('c1'), body: TEXT.question }, qid = q.requestId.toLowerCase();
    const signed = await request('c1', 'question.create', qid, q, { studyId: uid });
    out.first = await attempt(() => S.questions.create(uid, caller('c1'), q, signed));
    out.replay = await attempt(() => S.questions.create(uid, caller('c1'), q, signed));
    out.replayUnsigned = await attempt(async () => S.questions.create(uid, caller('c1'), q, await request('c1', 'question.create', qid, q, { studyId: uid, unsigned: true })));
    out.reused = await attempt(async () => S.questions.create(uid, caller('c1'), { ...q, body: 'SYN 다른 내용' }, signed));
    const t = { requestId: uuid(), expectedOwner: owner('c1'), body: TEXT.question };
    out.tampered = await attempt(async () => S.questions.create(uid, caller('c1'), t, await request('c1', 'question.create', t.requestId.toLowerCase(), t,
      { studyId: uid, change: x => ({ ...x, text: { kind: 'clinical-entry', body: 'SYN 서명된 다른 문장' } }) })));
    out.tamperedAgain = await attempt(async () => S.questions.create(uid, caller('c1'), t, await request('c1', 'question.create', t.requestId.toLowerCase(), t, { studyId: uid })));
    const stale = { requestId: uuid(), expectedOwner: owner('r1'), revision: 5, body: TEXT.answer };
    out.stale = await attempt(async () => S.questions.reply(qid, caller('r1'), stale, await request('r1', 'question.reply', qid, { ...stale, revision: 1 }, { studyId: uid })));
    out.ids = { question: qid, tampered: t.requestId.toLowerCase(), stale: stale.requestId.toLowerCase() };
    return out;
  },
  /** TEST-D-04 continued: after the projection was moved under the service (by the fixture), a reply rolls back whole. */
  async 'd04-diverged'({ args, S, request, attempt, caller, owner, TEXT }) {
    const a = { requestId: uuid(), expectedOwner: owner('r1'), revision: 1, body: TEXT.answer };
    return { reply: await attempt(async () => S.questions.reply(args.question, caller('r1'), a, await request('r1', 'question.reply', args.question, a, { studyId: args.study }))),
      requestId: a.requestId.toLowerCase() };
  },

  /** The candidate flow: write -> amend (a signed correction keeping the original) -> reopen in another process. */
  async 'flow-write'({ args, S, request, attempt, caller, owner, findingText, body, TEXT }) {
    const uid = args.study, out = {};
    const item = { schemaVersion: 1, title: 'SYN 결절', text: 'SYN 좌하엽 6 mm 결절', sources: [{ itemId: args.itemId, revision: 1 }] };
    const fc = { requestId: uuid(), item }, fid = uuid();
    out.create = await attempt(async () => S.findings.write(uid, body(fc), caller('r1'), undefined,
      await request('r1', 'finding.create', fid, fc, { studyId: uid, content: await findingText(uid, item, item.sources) })));
    const id = out.create.ok ? out.create.value.id : null;
    if (id) {
      const amended = { ...item, text: 'SYN 좌하엽 7 mm 결절 (재측정)' };
      const edit = { requestId: uuid(), expectedRevision: 1, action: 'edit', item: amended };
      out.edit = await attempt(async () => S.findings.write(uid, body(edit), caller('r1'), id,
        await request('r1', 'finding.edit', id, edit, { studyId: uid, content: await findingText(uid, amended, amended.sources) })));
    }
    const q = { requestId: uuid(), expectedOwner: owner('c1'), body: TEXT.question }, qid = q.requestId.toLowerCase();
    out.question = await attempt(async () => S.questions.create(uid, caller('c1'), q, await request('c1', 'question.create', qid, q, { studyId: uid })));
    const a = { requestId: uuid(), expectedOwner: owner('r1'), revision: 1, body: TEXT.answer };
    out.answer = await attempt(async () => S.questions.reply(qid, caller('r1'), a, await request('r1', 'question.reply', qid, a, { studyId: uid })));
    out.ids = { finding: id, question: qid };
    return out;
  },
  async 'flow-reopen'({ args, S, runtime, attempt, caller, actorFacts, dev, req }) {
    const out = {};
    const verify = req('emr-signature/verify');
    const unit = await runtime.store.unit(args.finding);
    const signatures = await runtime.store.signatures(args.finding);
    out.finding = { revision: unit?.revision, texts: unit?.versions.map(v => v.text), entries: unit?.versions.map(v => v.entry),
      acts: unit?.versions.map(v => v.act), previous: unit?.versions.map(v => v.previousVersion?.versionId ?? null), versionIds: unit?.versions.map(v => v.versionId),
      signatures: [...signatures.entries()].map(([versionId, s]) => {
        try { const v = verify.verifySignatureV2(s.envelope.jws, dev.ports, { osUserId: s.envelope.osUserId });
          return { versionId, signedVersion: v.payload.versionId, text: v.payload.text.body, integrity: v.integrity, key: v.keyAtSigningTime }; }
        catch (e) { return { versionId, error: describe(e) }; }
      }) };
    out.revisions = await attempt(async () => S.findings.list(args.study, {}, caller('r1'), args.finding, '2'));
    out.thread = await attempt(async () => S.questions.read(args.question, caller('c1'), { actor: await actorFacts('c1'), signature: null }));
    out.open = await runtime.recoverOpen();
    return out;
  },
};
