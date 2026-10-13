/* R5a live scenarios: real PostgreSQL versions/projections/request registry, C signatures and B receipts.
 * Synthetic identities/Orthanc only; invoked solely by the gated EmrDLive fixture. No HTTP authority is fabricated.
 */
'use strict';
const assert = require('node:assert/strict');
const { randomUUID: uuid, createHash } = require('node:crypto');
const hash = b => createHash('sha256').update(b).digest('hex');

module.exports = {
  async 'r5a-prepared-sr-fixture'({ args, req, prisma, PEOPLE }) {
    const { srFile, srUid, SR_CLASS } = req('manual-sr-dicom'), id = uuid();
    const dataset = { SpecificCharacterSet: 'ISO_IR 192', SOPClassUID: SR_CLASS, SOPInstanceUID: srUid('synthetic:' + id),
      StudyInstanceUID: args.study, Modality: 'SR', PatientID: 'SYN-PATIENT-1',
      ContentSequence: [{ ValueType: 'TEXT', RelationshipType: 'CONTAINS', TextValue: 'SYN prepared measurement copy' }] };
    const bytes = srFile(dataset), who = args.author ?? 'r1';
    await prisma.manualSr.create({ data: { id, studyUid: args.study, authorSub: PEOPLE[who].sub, authorActor: who + '@synthetic.test',
      requestId: uuid(), fingerprint: hash(bytes), selection: [{ id: args.item, revision: 1 }], dataset, dicom: bytes, sha256: hash(bytes) } });
    return { id, sop: dataset.SOPInstanceUID, hex: bytes.toString('hex') };
  },
  async 'r5a-metadata'({ args, S, prisma, request, caller, owner, PEOPLE, body, findingText, sourcesOf, runtime, req, orthanc }) {
    const uid = args.study, out = {};
    const policy = { version: 1, restricted: true, startsAt: null, endsAt: null,
      rules: [{ patientId: 'SYN-PATIENT-1', modalities: ['CT'], dateFrom: null, dateTo: null, studyUids: [] }] };
    for (const name of ['c1', 'r1', 'r2', 't1']) await prisma.studyAccessPolicy.upsert({ where: { institution_subject: { institution: 'inst-a', subject: PEOPLE[name].sub } },
      create: { subject: PEOPLE[name].sub, institution: 'inst-a', revision: 1, policy, reason: 'SYN metadata admission', updatedBy: PEOPLE.ad.sub },
      update: { policy, revision: { increment: 1 } } });
    const q = { requestId: uuid(), expectedOwner: owner('c1'), body: 'SYN metadata question' };
    out.question = await S.questions.create(uid, caller('c1'), q, await request('c1', 'question.create', q.requestId, q, { studyId: uid }));
    const a = { requestId: uuid(), expectedOwner: owner('r1'), revision: 1, body: 'SYN metadata answer' };
    out.answer = await S.questions.reply(q.requestId, caller('r1'), a, await request('r1', 'question.reply', q.requestId, a, { studyId: uid }));
    const ir = { requestId: uuid(), expectedOwner: owner('c1'), kind: 'external-image', counterparty: 'SYN', counterpartyInstitutionId: null, reason: 'SYN metadata image' };
    out.image = await S.requests.create(uid, caller('c1'), ir, await request('c1', 'image-request.create', ir.requestId, ir, { studyId: uid }));
    const change = { requestId: uuid(), expectedOwner: owner('t1'), revision: 1, action: 'accept', note: '' };
    out.imageChange = await S.requests.change(ir.requestId, caller('t1'), change, await request('t1', 'image-request.accept', ir.requestId, change, { studyId: uid }));
    const c = { requestId: uuid(), expectedOwner: owner('r1'), recipientSub: PEOPLE.r2.sub, reason: 'SYN metadata consultation' };
    out.consultation = await S.consultations.create(uid, caller('r1'), c, await request('r1', 'consultation.create', c.requestId, c, { studyId: uid, recipientSub: PEOPLE.r2.sub }));
    const item = { schemaVersion: 1, title: 'SYN metadata', text: 'SYN finding', sources: [{ itemId: args.item, revision: 1 }] }, f = { requestId: uuid(), item };
    out.finding = await S.findings.write(uid, body(f), caller('r1'), undefined, await request('r1', 'finding.create', f.requestId, f,
      { studyId: uid, content: await findingText(uid, item, item.sources), sources: sourcesOf(item) }));
    const assign = { requestId: uuid(), expectedOwner: owner('t1'), revision: 0, readerSub: PEOPLE.r1.sub };
    out.assignment = await S.assignments.write(uid, caller('t1'), assign, await request('t1', 'assignment.write', '', assign, { studyId: uid }));
    // A metadata outage between signing and commit leaves a registered original pending. Fresh recovery re-prepares it.
    const retry = { requestId: uuid(), expectedOwner: owner('c1'), body: 'SYN metadata recovery' };
    const signed = await request('c1', 'question.create', retry.requestId, retry, { studyId: uid });
    const prepare = req('emr-clinical/services').clinicalServices.prepareProjection.get('question');
    req('emr-clinical/services').clinicalServices.prepareProjection.set('question', async () => { throw Error('SYN metadata temporarily unavailable'); });
    try { await S.questions.create(uid, caller('c1'), retry, signed); assert.fail('metadata outage must not succeed'); }
    catch (e) { if (e.code === 'ERR_ASSERTION') throw e; }
    finally { req('emr-clinical/services').clinicalServices.prepareProjection.set('question', prepare); }
    await runtime.recoverOpen();
    out.recovery = await S.questions.create(uid, caller('c1'), retry, signed);
    out.ids = { question: q.requestId, image: ir.requestId, consultation: c.requestId, finding: f.requestId, recovery: retry.requestId };
    return out;
  },
  async 'r5a-limits'({ args, S, request, caller, owner, attempt }) {
    const uid = args.study, text = args.text, create = { requestId: uuid(), expectedOwner: owner('c1'), body: text }, id = create.requestId;
    await S.questions.create(uid, caller('c1'), create, await request('c1', 'question.create', id, create, { studyId: uid }));
    for (let revision = 1; revision < 99; revision++) {
      const name = revision % 2 ? 'r1' : 'c1', b = { requestId: uuid(), expectedOwner: owner(name), revision, body: text };
      await S.questions.reply(id, caller(name), b, await request(name, 'question.reply', id, b, { studyId: uid }));
    }
    const extra = { requestId: uuid(), expectedOwner: owner('r1'), revision: 99, body: text };
    const over = await attempt(async () => S.questions.reply(id, caller('r1'), extra, await request('r1', 'question.reply', id, extra, { studyId: uid })));
    const close = { requestId: uuid(), expectedOwner: owner('c1'), revision: 99, note: text };
    const signed = await request('c1', 'question.close', id, close, { studyId: uid });
    const closed = await S.questions.close(id, caller('c1'), close, signed), replay = await S.questions.close(id, caller('c1'), close, signed);
    return { id, over, closed, replay };
  },
  async 'r5a-acks'({ args, S, request, caller, owner, prisma, attempt }) {
    const q = { requestId: uuid(), expectedOwner: owner('c1'), body: 'SYN original' }, id = q.requestId;
    const signed = await request('c1', 'question.create', id, q, { studyId: args.study });
    await S.questions.create(args.study, caller('c1'), q, signed);
    const entry = await prisma.studyQuestionEntry.findUnique({ where: { id } });
    await prisma.studyQuestionEntry.update({ where: { id }, data: { result: { ...entry.result, body: 'SYN forbidden', note: 'SYN forbidden', extra: { reason: 'SYN forbidden' } } } });
    const replay = await S.questions.create(args.study, caller('c1'), q, signed);
    await prisma.studyQuestionEntry.update({ where: { id }, data: { result: { ...entry.result, revision: 77 } } });
    const corrupted = await attempt(() => S.questions.create(args.study, caller('c1'), q, signed));
    await prisma.studyQuestionEntry.update({ where: { id }, data: { result: entry.result } });
    return { id, replay, corrupted };
  },
  async 'r5a-seal-retry'({ args, S, request, caller, owner, PEOPLE, prisma, ledger, runtime, attempt }) {
    const uid = args.study, b = { requestId: uuid(), expectedOwner: owner('t1'), revision: 0, readerSub: PEOPLE.r1.sub };
    await prisma.studyState.update({ where: { uid }, data: { holder: 'r1@synthetic.test', heldAt: new Date() } });
    const signed = await request('t1', 'assignment.write', '', b, { studyId: uid });
    const originalDb = runtime.store.db, raw = originalDb.$queryRaw.bind(originalDb); let attempts = 0;
    // Prisma constructs transaction clients from its root client. Replacing the root method would accidentally send
    // their queries outside the transaction; fault only the store's separate post-commit seal transport instead.
    runtime.store.db = new Proxy(originalDb, { get(target, key) {
      if (key === '$queryRaw') return (...v) => {
        if (Array.isArray(v[0]) && v[0].join('').includes('emr_clinical.seal_rejected')) { attempts++; throw Error('SYN seal transport failure'); }
        return raw(...v);
      };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const trace = [], transaction = ledger.withAppendTransaction.bind(ledger);
    ledger.withAppendTransaction = async work => { try { return await transaction(work); }
      catch (error) { trace.push({ name: error.name, code: error.code, sqlState: error.meta?.code ?? null }); throw error; } };
    let first;
    try { first = await attempt(() => S.assignments.write(uid, caller('t1'), b, signed)); }
    finally { runtime.store.db = originalDb; }
    // A later mutable condition cannot change the original refusal after its durable no-effects decision.
    await prisma.studyState.update({ where: { uid }, data: { holder: null, heldAt: null } });
    await runtime.recoverOpen();
    const retry = await attempt(() => S.assignments.write(uid, caller('t1'), b, signed));
    return { requestId: b.requestId, first, retry, attempts, trace };
  },
  async 'r5a-registry-race'({ args, S, request, caller, owner, PEOPLE, runtime, attempt }) {
    const uid = args.study, b = { requestId: uuid(), expectedOwner: owner('t1'), revision: 0, readerSub: PEOPLE.r1.sub };
    const signed = await request('t1', 'assignment.write', '', b, { studyId: uid });
    const originalObserve = runtime.store.observe.bind(runtime.store); let paused = false, registered;
    runtime.store.observe = async (...params) => {
      const observed = await originalObserve(...params);
      if (!paused && observed.state === 'absent') {
        paused = true;
        registered = await S.assignments.write(uid, caller('t1'), b, signed);
      }
      return observed;
    };
    let racing;
    try { racing = await S.assignments.write(uid, caller('t1'), b, signed); }
    finally { runtime.store.observe = originalObserve; }
    const changed = await attempt(() => S.assignments.write(uid, caller('t1'), { ...b, readerSub: PEOPLE.r2.sub }, signed));
    assert.deepEqual(racing, registered, 'absent observer converges to the authoritative committed request');
    return { requestId: b.requestId, racing, registered, changed };
  },
};
