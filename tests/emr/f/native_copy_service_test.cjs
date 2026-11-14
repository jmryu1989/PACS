/* REQ-EMR-16 -> RISK-F-03/04 -> TEST-F-NATIVE-COPY. REQ-EMR-17 -> TEST-F-NATIVE-RIGHTS.
 * The F service over synthetic native report storage (native_harness.cjs). Real PostgreSQL rows, locks and the real
 * commit route are exercised by native_copy_pg_test.cjs; this suite holds the contract cases that need no database.
 */
'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHash } = require('node:crypto');
const { fixture, copyIntake, rightsIntake, UID, digest, F } = require('./native_harness.cjs');
const F_state = issuance => F.issuanceState(issuance).state;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const all = (recordKind) => [{ recordId: UID, versions: 'all', ...(recordKind ? { recordKind } : {}) }];
const versionsOf = issuance => issuance.manifest.records[0].versions.map(v => [v.versionId, v.act, v.signature !== null]);

test('legacy signed bytes and predecessor hashes survive nullable scope columns; a new format binds the exam reference',async()=>{
  const f=fixture();const first=f.commit(UID,'approve','SYN OLD');
  const original=JSON.stringify(first.row),signature=JSON.stringify(first.signature),oldHash=sha(original);
  Object.assign(first.row,{groupId:null,snapshotFormat:1});
  const oldCopy=await f.controller.prepare({},copyIntake('SYN-LEGACY-SCOPE',all()));
  assert.equal(oldCopy.manifest.records[0].head.sha256,oldHash);
  const issued=await f.controller.issue({},oldCopy.issuanceId);
  const doc=JSON.parse(Buffer.from(issued.artifact,'base64'));
  assert.deepEqual(JSON.parse(doc.originals[0].original),JSON.parse(signature));
  const next=f.commit(UID,'save','SYN NEW').row;
  next.action='addendum';Object.assign(next,{groupId:'00000000-0000-4000-8000-000000000001',snapshotFormat:2});
  const {snapshotFormat,...record}=next;
  const body=JSON.stringify({formatVersion:'native-report/2',report:record,exam:{reportUid:UID,groupId:next.groupId}});
  f.sign(next,first.row,'addendum',{body,previousSha:oldHash});
  const copy=await f.controller.prepare({},copyIntake('SYN-MIXED-SCOPE',all()));
  assert.deepEqual(copy.manifest.records[0].versions.map(v=>v.predecessor?.sha256??null),[null,oldHash]);
  assert.equal(copy.manifest.records[0].head.sha256,sha(body));
  assert.equal(JSON.stringify(first.signature),signature);
  next.groupId=null;
  await assert.rejects(f.controller.prepare({},copyIntake('SYN-ALTERED-SCOPE',all())));
});

test('legacy explicit-null scope bytes survive as signed and unsigned predecessors', async () => {
  for (const signed of [true, false]) {
    const f = fixture(), first = f.commit(UID, 'save', 'SYN LEGACY NULL').row;
    first.groupId = null;
    if (signed) first.action = 'approve';
    const original = JSON.stringify(first), oldHash = sha(original);
    if (signed) f.sign(first, null, 'approve-sign', { body: original });
    first.snapshotFormat = 1;
    const next = f.commit(UID, 'save', 'SYN NEW FORMAT').row;
    Object.assign(next, { action: 'addendum', groupId: null, snapshotFormat: 2 });
    const { snapshotFormat, ...record } = next;
    const body = JSON.stringify({ formatVersion: 'native-report/2', report: record, exam: { reportUid: UID, groupId: null } });
    f.sign(next, first, 'addendum', { body, previousSha: oldHash });
    const prepared = await f.controller.prepare({}, copyIntake('SYN-NULL-' + signed, all()));
    assert.equal(prepared.manifest.records[0].versions[0].sha256, oldHash);
    assert.equal(prepared.manifest.records[0].versions[1].predecessor.sha256, oldHash);
  }
});

test('a native report is copied as its head chain: unsigned saves, signed approvals and a content reset', async () => {
  const f = fixture();
  f.commit(UID, 'save', '저장한 소견'); const approved = f.commit(UID, 'approve', '확정 소견');
  const added = f.commit(UID, 'addendum', '추가 소견');
  const prepared = await f.controller.prepare({}, copyIntake('SYN-NATIVE-1', all()));
  assert.deepEqual(versionsOf(prepared), [['1', 'save', false], ['2', 'approve', true], ['3', 'addendum', true]]);
  const head = f.rows.at(-1);
  assert.deepEqual(prepared.manifest.records[0].head, { versionId: '3', sha256: digest(head) });
  assert.equal(prepared.manifest.records[0].recordKind, 'report');
  // Each version's predecessor is the previous head row digest the signer bound (native-signing.ts previousVersion).
  assert.deepEqual(prepared.manifest.records[0].versions.map(v => v.predecessor?.sha256 ?? null), [null, digest(f.rows[0]), digest(f.rows[1])]);
  const issued = await f.controller.issue({}, prepared.issuanceId);
  const document = JSON.parse(Buffer.from(issued.artifact, 'base64'));
  assert.deepEqual(JSON.parse(document.originals[1].original), JSON.parse(JSON.stringify(approved.signature)), 'stored signed original');
  assert.deepEqual(JSON.parse(document.originals[2].original), JSON.parse(JSON.stringify(added.signature)));
  assert.deepEqual(JSON.parse(JSON.parse(document.originals[0].original).reportVersion), JSON.parse(JSON.stringify(f.rows[0])), 'unsigned row as stored');
  const read = await f.controller.issuance({}, prepared.issuanceId);
  assert.equal(read.artifact, issued.artifact); assert.equal(sha(Buffer.from(read.artifact, 'base64')), read.sha256);

  const g = fixture(); const uid = UID;
  g.commit(uid, 'approve', '첫 소견'); g.commit(uid, 'reset', '', '합성 정정'); g.commit(uid, 'save', '다시 저장'); g.commit(uid, 'approve', '다시 확정');
  assert.deepEqual(g.rows.map(r => [r.version, r.action]), [[1, 'approve'], [2, 'discarded'], [3, 'reset'], [4, 'save'], [5, 'approve']]);
  const again = await g.controller.prepare({}, copyIntake('SYN-NATIVE-2', all()));
  assert.deepEqual(versionsOf(again), [['1', 'approve', true], ['3', 'reset', true], ['4', 'save', false], ['5', 'approve', true]]);
  assert.equal(again.manifest.records[0].versions[1].predecessor.versionId, '1', 'a reset follows the head, not its discarded snapshot');
});

test('FC-034: amendments within the window are signed versions of the head chain, each bound to the head before it', async () => {
  const f = fixture();
  f.commit(UID, 'approve', '확정 소견'); f.commit(UID, 'amend', '고친 소견'); const second = f.commit(UID, 'amend', '다시 고친 소견');
  f.commit(UID, 'addendum', '추가 소견');
  const prepared = await f.controller.prepare({}, copyIntake('SYN-NATIVE-AMEND', all()));
  assert.deepEqual(versionsOf(prepared), [['1', 'approve', true], ['2', 'amend', true], ['3', 'amend', true], ['4', 'addendum', true]]);
  // The second amendment follows the first amendment, not the approval.
  assert.deepEqual(prepared.manifest.records[0].versions.map(v => v.predecessor?.versionId ?? null), [null, '1', '2', '3']);
  const issued = await f.controller.issue({}, prepared.issuanceId);
  const document = JSON.parse(Buffer.from(issued.artifact, 'base64'));
  assert.deepEqual(JSON.parse(document.originals[2].original), JSON.parse(JSON.stringify(second.signature)), 'stored signed amendment');
});

test('native boundaries: discarded rows stay out, unsigned or orphan evidence is refused before any issuance', async () => {
  const d = fixture();
  d.commit(UID, 'approve', '확정'); d.discard(UID);
  assert.equal(d.rows.at(-1).action, 'discarded'); assert.equal(d.reports.get(UID).version, 1, 'force-discard leaves the head');
  const kept = await d.controller.prepare({}, copyIntake('SYN-DISCARD', all()));
  assert.deepEqual(versionsOf(kept), [['1', 'approve', true]]);

  const cases = [
    ['save only', f => f.commit(UID, 'save'), 'VersionListingIncomplete'],
    ['approve without its signature', f => { f.commit(UID, 'save'); f.commit(UID, 'approve'); f.signed.delete(UID); }, 'SignatureEvidenceRequired'],
    ['reset of an existing report without its signature', f => {
      f.commit(UID, 'approve'); f.commit(UID, 'reset', '', '정정'); f.signed.set(UID, f.signed.get(UID).slice(0, 1)); }, 'SignatureEvidenceRequired'],
    ['signature of a discarded version', f => {
      f.commit(UID, 'approve'); const gone = f.discard(UID); f.sign(gone, f.rows[0], 'addendum'); }, 'SignatureEvidenceMismatch'],
    ['signed body differs from the stored row', f => {
      const { row } = f.commit(UID, 'approve', '원래 소견'); row.findings = '나중에 바뀐 소견'; }, 'SignatureEvidenceMismatch'],
    ['report head is not the last shared row', f => { f.commit(UID, 'approve'); f.reports.set(UID, { version: 7 }); }, 'VersionListingIncomplete'],
  ];
  for (const [name, arrange, code] of cases) {
    const f = fixture(); arrange(f);
    await assert.rejects(f.controller.prepare({}, copyIntake('SYN-' + name, all())), { code }, name);
    assert.equal(f.issuances.length, 0, name + ': no issuance');
    assert.equal(f.requests.length, 1, name + ': intake and hold stay committed');
  }
});

test('the same Study UID names a Tech Note and a report: recordKind selects one, an unselected request is refused', async () => {
  const f = fixture();
  f.techNote(UID); f.commit(UID, 'approve', '판독 소견');
  await assert.rejects(f.controller.prepare({}, copyIntake('SYN-AMBIGUOUS', all())), { code: 'RecordKindAmbiguous' });
  assert.equal(f.requests.length, 0, 'an ambiguous intake stores nothing'); assert.equal(f.issuances.length, 0);
  const report = await f.controller.prepare({}, copyIntake('SYN-REPORT', all('report')));
  assert.deepEqual(versionsOf(report), [['1', 'approve', true]]); assert.equal(report.manifest.records[0].recordKind, 'report');
  const note = await f.controller.prepare({}, copyIntake('SYN-NOTE', all('clinical')));
  assert.equal(note.manifest.records[0].recordKind, 'clinical');
  assert.deepEqual(note.manifest.records[0].versions.map(v => v.versionId), [f.clinical.get(UID)[0] && JSON.parse(f.clinical.get(UID)[0].body).version.versionId]);
  // The selector is part of the request: the same ID with another selector is the existing conflict.
  await assert.rejects(f.controller.prepare({}, copyIntake('SYN-REPORT', all('clinical'))), { code: 'DisclosureRequestConflict' });
  const issued = await f.controller.issue({}, report.issuanceId);
  const originals = JSON.parse(Buffer.from(issued.artifact, 'base64')).originals;
  assert.ok(originals.every(o => !JSON.parse(o.original).plan), 'a report copy never carries the Tech Note');

  // Saved before the second source existed: Issued bytes replay, an unselected Prepared does not silently pick a source.
  const g = fixture(); g.commit(UID, 'approve', '판독');
  const old = await g.controller.prepare({}, copyIntake('SYN-OLD-ISSUED', all()));
  const oldBytes = (await g.controller.issue({}, old.issuanceId)).artifact;
  const pending = await g.controller.prepare({}, copyIntake('SYN-OLD-PREPARED', all()));
  g.legacyIssuances();
  g.techNote(UID);
  const replay = await g.controller.issue({}, old.issuanceId);
  assert.equal(replay.artifact, oldBytes, 'issued bytes are replayed without reading either source');
  await assert.rejects(g.controller.issue({}, pending.issuanceId), { code: 'RecordKindAmbiguous' });
});

test('a Tech Note stored with its route response is copied, printed and decided like a bare plan', async () => {
  const f = fixture(), plan = f.techNote(UID, '조영제 주입 후 오심', { note: { version: 1 } });
  for (const format of ['signed-electronic', 'paper-print']) {
    const prepared = await f.controller.prepare({}, copyIntake('SYN-RESPONSE-' + format, all('clinical'), format));
    assert.deepEqual(prepared.manifest.records[0].versions.map(v => v.versionId), [plan.version.versionId]);
    const issued = await f.controller.issue({}, prepared.issuanceId), bytes = Buffer.from(issued.artifact, 'base64').toString('utf8');
    if (format === 'signed-electronic') assert.equal(JSON.parse(bytes).originals[0].original, JSON.stringify({ plan: f.clinical.get(UID)[0].body, signature: null }), 'stored text kept');
    else assert.ok(bytes.includes('조영제 주입 후 오심'));
  }
  await f.controller.receiveRights({}, rightsIntake('SYN-R-RESPONSE', [{ recordId: UID, recordKind: 'clinical' }]));
  assert.equal((await f.controller.decideRights({}, 'SYN-R-RESPONSE')).decision.records[0].recordKind, 'clinical');
});
test('rights requests select the record kind and keep string record IDs for holds, duties and audit targets', async () => {
  const f = fixture();
  f.techNote(UID); f.commit(UID, 'approve', '판독 소견');
  await assert.rejects(f.controller.receiveRights({}, rightsIntake('SYN-R-AMBIGUOUS', [UID])), { code: 'RecordKindAmbiguous' });
  assert.equal(f.requests.length, 0);
  const selected = rightsIntake('SYN-R-REPORT', [{ recordId: UID, recordKind: 'report' }]);
  const received = await f.controller.receiveRights({}, selected);
  assert.deepEqual(received.request.recordIds, [UID]); assert.deepEqual(received.request.recordKinds, { [UID]: 'report' });
  assert.deepEqual(JSON.parse(f.duties.at(-1).values[1]).recordIds, [UID], 'the duty names the string record ID');
  assert.equal(f.records.at(-1).targets[0].recordId.value, UID);
  assert.equal((await f.controller.receiveRights({}, selected)).status, 'Received', 'the same selected request replays');
  await assert.rejects(f.controller.receiveRights({}, rightsIntake('SYN-R-REPORT', [UID])), { code: 'RightsRequestConflict' });
  const decided = await f.controller.decideRights({}, 'SYN-R-REPORT');
  assert.deepEqual(decided.decision.records.map(r => [r.recordId, r.recordKind]), [[UID, 'report']]);
  const note = await f.controller.receiveRights({}, rightsIntake('SYN-R-NOTE', [{ recordId: UID, recordKind: 'clinical' }]));
  assert.equal((await f.controller.decideRights({}, note.request.requestId)).decision.records[0].recordKind, 'clinical');
});

test('a moved head is refused at first issue and re-prepared; an issued copy is replayed', async () => {
  const f = fixture();
  f.commit(UID, 'approve', '확정');
  const input = copyIntake('SYN-MOVE', all('report')), stale = await f.controller.prepare({}, input);
  f.commit(UID, 'addendum', '추가');
  await assert.rejects(f.controller.issue({}, stale.issuanceId), { code: 'RecordHeadChanged' });
  const fresh = await f.controller.prepare({}, input);
  assert.notEqual(fresh.issuanceId, stale.issuanceId); assert.equal(fresh.manifest.records[0].versions.length, 2);
  assert.equal(f.issuances.filter(r => r.body.issuanceId === stale.issuanceId).at(-1).body.events.at(-1).kind, 'aborted');
  const issued = await f.controller.issue({}, fresh.issuanceId);
  f.commit(UID, 'addendum', '발급 뒤 추가');
  assert.equal((await f.controller.issue({}, fresh.issuanceId)).artifact, issued.artifact, 'same issuance replays stored bytes');
});

test('a resolved request issues nothing new: withdrawn/refused abort the prepared copy, an issued copy is kept', async () => {
  for (const outcome of ['withdrawn', 'lawfully-refused']) {
    const f = fixture(); f.commit(UID, 'approve', '확정');
    const input = copyIntake('SYN-END-' + outcome, all('report')), prepared = await f.controller.prepare({}, input);
    await f.controller.resolve({}, input.request.requestId, { outcome, evidenceId: 'SYN-END' });
    const last = f.issuances.filter(r => r.body.issuanceId === prepared.issuanceId).at(-1).body;
    assert.equal(F_state(last), 'Aborted', outcome + ': the prepared copy is aborted in the resolving transaction');
    await assert.rejects(f.controller.issue({}, prepared.issuanceId), { code: 'RequestAlreadyResolved' });
    await assert.rejects(f.controller.prepare({}, input), { code: 'RequestAlreadyResolved' });
    assert.equal(f.copies.size, 0, outcome + ': no copy bytes');
  }
  const f = fixture(); f.commit(UID, 'approve', '확정');
  const input = copyIntake('SYN-END-ISSUED', all('report')), prepared = await f.controller.prepare({}, input);
  const issued = await f.controller.issue({}, prepared.issuanceId);
  await f.controller.resolve({}, input.request.requestId, { outcome: 'withdrawn', evidenceId: 'SYN-END' });
  assert.equal(F_state(f.issuances.at(-1).body), 'Issued', 'an issued copy is not aborted');
  assert.equal((await f.controller.issue({}, prepared.issuanceId)).artifact, issued.artifact, 'issued bytes replay after the end');
});

test('selector-free controls on the stored C2 record: end of request and issue lock order', async () => {
  // These inputs are valid before recordKind exists, so a failure here is the resolution/lock defect itself.
  const { fixture: c2Fixture, intake } = require('./disclosure_harness.cjs');
  const f = c2Fixture(), input = intake('SYN-C2-END'), prepared = await f.controller.prepare({}, input);
  await f.controller.resolve({}, input.request.requestId, { outcome: 'withdrawn', evidenceId: 'SYN-END' });
  await assert.rejects(f.controller.issue({}, prepared.issuanceId), { code: 'RequestAlreadyResolved' });
  assert.equal(f.copies.size, 0, 'no copy after the request ended');
  const g = c2Fixture(), second = intake('SYN-C2-LOCKS'), ready = await g.controller.prepare({}, second);
  g.locks.length = 0; await g.controller.issue({}, ready.issuanceId);
  assert.deepEqual(g.locks.map(k => JSON.parse(k)[0]), ['emr-f-roster', 'emr-f-request', 'emr-f-issuance', 'emr-fixed-record']);
});

test('every F path takes roster, request, issuance, then the full fixed-record set', async () => {
  const f = fixture(); f.commit(UID, 'approve', '확정'); f.commit('2.25.7000', 'approve', '다른 검사');
  const kind = key => JSON.parse(key)[0];
  const order = () => f.locks.map(kind).filter((k, i, a) => k !== a[i - 1]);
  const scope = [{ recordId: UID, versions: 'all', recordKind: 'report' }, { recordId: '2.25.7000', versions: 'all', recordKind: 'report' }];
  const input = copyIntake('SYN-LOCKS', scope);
  f.locks.length = 0; await f.controller.register({}, input);
  assert.deepEqual(order(), ['emr-f-roster', 'emr-f-request', 'emr-fixed-record']);
  assert.deepEqual(f.locks.filter(k => kind(k) === 'emr-fixed-record').map(k => JSON.parse(k)[1]), ['2.25.7000', UID], 'sorted complete set');
  f.locks.length = 0; const prepared = await f.controller.prepare({}, input);
  // The stored intake answers the register step; the preparing transaction has no issuance yet.
  assert.deepEqual(order(), ['emr-f-roster', 'emr-f-request', 'emr-f-roster', 'emr-f-request', 'emr-fixed-record'], 'register then prepare');
  f.commit(UID, 'addendum', '추가');
  f.locks.length = 0; await f.controller.prepare({}, input).catch(() => {});
  assert.deepEqual(order().slice(-4), ['emr-f-roster', 'emr-f-request', 'emr-f-issuance', 'emr-fixed-record'], 're-prepare of a saved issuance');
  const current = f.requests.filter(r => r.body.facts?.requestId === 'SYN-LOCKS').at(-1).body.issuanceId;
  assert.notEqual(current, prepared.issuanceId);
  f.locks.length = 0; await f.controller.issue({}, current);
  assert.deepEqual(order(), ['emr-f-roster', 'emr-f-request', 'emr-f-issuance', 'emr-fixed-record'], 'issue');
  f.locks.length = 0; await f.controller.resolve({}, input.request.requestId, { outcome: 'withdrawn', evidenceId: 'SYN-END' });
  assert.deepEqual(order(), ['emr-f-roster', 'emr-f-request', 'emr-f-issuance', 'emr-fixed-record'], 'resolve');
  f.locks.length = 0; await f.controller.receiveRights({}, rightsIntake('SYN-R-LOCKS', [{ recordId: UID, recordKind: 'report' }]));
  assert.deepEqual(order(), ['emr-f-roster', 'emr-f-request', 'emr-fixed-record'], 'rights intake');
});

test('F-6: every F route answers B2\'s judgement of its COMMIT as the clinical routes do', async () => {
  // Real Nest routing and exception handling over the real controller/service; only B2's transaction port is synthetic.
  // The deferred-constraint case itself (the task ran, COMMIT failed, no copy) is FT10(c) in native_copy_pg_test.cjs.
  const path = require('node:path'), API = path.resolve(__dirname, '../../../api');
  const dependency = name => require(path.join(API, 'node_modules', name));
  const { Module, RequestMethod } = dependency('@nestjs/common'), { NestFactory } = dependency('@nestjs/core');
  const { EmrAuditService } = require(path.join(API, 'src/emr-audit/service.ts'));
  const { EmrAuditController } = require(path.join(API, 'src/emr-audit/audit.controller.ts'));
  const { LedgerFailure } = require(path.join(API, 'src/emr-runtime/store.ts'));
  const { ContractError } = require(path.join(API, 'src/emr-contract/validation.ts'));
  let failure;
  const ctx = { facts: {}, requireCurrent: async () => {}, assertActive: () => {},
    work: { transactionWithRecords: async () => { throw failure; } } };
  const service = new EmrAuditService({}, { withWork: async (req, task) => task(ctx) });
  class LedgerAnswerFixture {}
  Module({ controllers: [EmrAuditController], providers: [{ provide: EmrAuditService, useValue: service }] })(LedgerAnswerFixture);
  const app = await NestFactory.create(LedgerAnswerFixture, { logger: false });
  await app.listen(0, '127.0.0.1');
  try {
    const origin = await app.getUrl(), base = Reflect.getMetadata('path', EmrAuditController);
    const routes = Object.getOwnPropertyNames(EmrAuditController.prototype).map(name => EmrAuditController.prototype[name])
      .filter(handler => Reflect.getMetadata('method', handler) !== undefined)
      .map(handler => [RequestMethod[Reflect.getMetadata('method', handler)], Reflect.getMetadata('path', handler).replace(/:[a-zA-Z]+/g, 'SYN-1')]);
    const writes = routes.filter(([method]) => method === 'POST').map(([, route]) => route);
    assert.deepEqual(writes.filter(r => /^(requests|issuances|rights-requests)/.test(r)).sort(), ['issuances', 'issuances/SYN-1/delivery',
      'issuances/SYN-1/issue', 'requests', 'requests/SYN-1/extend', 'requests/SYN-1/resolve', 'rights-requests',
      'rights-requests/SYN-1/decide', 'rights-requests/SYN-1/notify'], 'receive, prepare, issue, withdrawal, rights decide/notify, resolve');
    const answer = async ([method, route]) => {
      const r = await fetch(`${origin}/${base}/${route}`, { method, headers: { 'content-type': 'application/json' },
        body: method === 'POST' ? '{}' : undefined });
      return { route: `${method} ${route}`, status: r.status, body: await r.json() };
    };
    const each = async (error, status, body) => {
      failure = error;
      for (const route of routes) assert.deepEqual(await answer(route), { route: `${route[0]} ${route[1]}`, status, body });
    };
    await each(new LedgerFailure('AppendNotCommitted'), 503,
      { code: 'AppendNotCommitted', stage: 'command', message: '저장이 완료되지 않았습니다. 입력은 유지됩니다.' });
    await each(new LedgerFailure('CommitUnknown'), 503,
      { code: 'OutcomeUnknown', stage: 'command', message: '저장 결과를 확인하지 못했습니다. 입력을 유지하고 같은 요청을 다시 확인하세요.' });
    // Other ledger failures and F's own refusals keep their answers.
    await each(new LedgerFailure('LedgerUnreachable'), 500, { statusCode: 500, message: 'Internal server error' });
    await each(new ContractError('RequestNotFound'), 404, { code: 'RequestNotFound', message: '감사 권한과 요청 상태를 확인하세요' });
  } finally { await app.close(); }
});
