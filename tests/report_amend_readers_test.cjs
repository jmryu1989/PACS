'use strict';
/*
 * FC-034 receiving side: a signed amendment (ReportVersion.action 'amend', made by the approving reader within 24 hours of
 * the first approval) is a final head for every reader of report versions, and the study answer carries the window.
 * Pure readers only, loaded from the TypeScript sources (Node >= 22.18 strips types; @nestjs/common is a stub here, so no
 * api/node_modules is needed). The PostgreSQL route cases are in tests/emr/d/report_commit_pg_test.cjs.
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const { registerHooks } = require('node:module');

class HttpError extends Error { constructor(body) { super(typeof body === 'string' ? body : body?.message); this.body = body; } getResponse() { return this.body; } }
const nest = ['BadRequestException', 'ConflictException', 'ForbiddenException', 'NotFoundException', 'GoneException',
  'HttpException', 'ServiceUnavailableException'].map(name => `export class ${name} extends (${HttpError.toString()}) {}`).join('\n');
const stub = 'data:text/javascript,' + encodeURIComponent(nest + '\nexport const RequestMethod = { GET: 0, POST: 1, PUT: 2, DELETE: 3, PATCH: 4, 0: "GET", 1: "POST", 2: "PUT", 3: "DELETE", 4: "PATCH" };');
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@nestjs/common') return { url: stub, format: 'module', shortCircuit: true };
  // The sources import their neighbours without an extension (the compiled image resolves .js).
  if (specifier.startsWith('.') && !path.extname(specifier)) {
    try { return next(specifier + '.ts', context); } catch { /* not a TypeScript neighbour */ }
  }
  return next(specifier, context);
} });
const src = name => require(path.resolve(__dirname, '..', 'api', 'src', name));
const clinician = src('clinician-policy.ts');
const critical = src('critical-result-policy.ts');
const related = src('report-related-insert.ts');
const values = src('pacs/values.ts');

const APPROVED = new Date('2026-11-10T01:00:00.000Z');
const AMENDED = new Date('2026-11-10T05:30:00.000Z');

test('an amended head at RS A is final for the clinician and the read says when it was amended; the list row is unchanged', () => {
  const head = { id: 9, version: 3, action: 'amend', findings: '고친 소견', conclusion: '결론', recommendation: '' };
  const state = { rs: 'A', repDoc: 'reader', confirm: '2026-11-10', approvedAt: APPROVED, amendedAt: AMENDED };
  assert.equal(clinician.clinicianFinal('A', head), true);
  assert.ok(clinician.CLINICIAN_FINAL_ACTIONS.includes('amend'));
  const view = clinician.clinicianReportView(state, head);
  assert.equal(view.final, true);
  assert.equal(view.action, 'amend');
  assert.equal(view.findings, '고친 소견');
  assert.equal(view.amendedAt, AMENDED.toISOString());
  // An approval or an Addendum head is not called amended, even after an earlier amendment of the same round.
  for (const action of ['approve', 'addendum'])
    assert.equal(clinician.clinicianReportView(state, { ...head, action }).amendedAt, null, action);
  // A study that is not final answers status only, as before.
  assert.equal('amendedAt' in clinician.clinicianReportView({ ...state, rs: 'P' }, head), false);
  // The list keeps its status shape: no new key.
  assert.equal('amendedAt' in clinician.clinicianReport(state, head), false);
});

test('a critical result can pin an amended head, and a clinician recipient reads it as a final source', () => {
  const head = { version: 4, action: 'amend' };
  assert.equal(critical.sourceRefusal({ sourceVersion: 4, head, senderReadable: true }), null);
  assert.equal(critical.createCase({ cls: 'clinician', visible: true, head, state: { rs: 'A' }, actor: 'me' }), 'C2');
});

test('a Related insert may take its source text from an amended head', () => {
  const raw = { intent: 'apply', insertRequestId: '6f1d0c6e-8c1b-4f7a-9d2e-0a1b2c3d4e5f',
    source: { uid: '1.2.3', version: 2, action: 'amend', parts: [{ field: 'findings', start: 0, end: 3 }] },
    targetUid: '1.2.4', targetBaseVersion: 0, section: 'findings', position: 'end', offset: 0, text: '고친 소견',
    selectionSeq: 1, contentRevision: 1, sourceGeneration: 1, seedKind: 'empty' };
  assert.equal(related.relatedInsertInput(raw, '1.2.4', { baseVersion: 0 }, { revision: 0 }).source.action, 'amend');
  assert.throws(() => related.relatedInsertInput({ ...raw, source: { ...raw.source, action: 'save' } }, '1.2.4', { baseVersion: 0 }, { revision: 0 }));
});

test('the study answer carries the amend window of the current approval round, never the approver subject', () => {
  const caller = { sub: 'sub-approver', actor: 'approver@example.test', roles: ['radiologist'], institution: 'SYN' };
  const s = { rs: 'A', ss: 'Verified', em: 'N', ts: 'none', draftEpoch: '00000000-0000-4000-8000-000000000001',
    approvedAt: APPROVED, approvedBySub: 'sub-approver', amendedAt: AMENDED, addendumAt: null };
  const r = { version: 3, findings: 'f', conclusion: 'c', recommendation: '', updatedBy: 'approver@example.test' };
  const mine = values.toClient(s, r, caller);
  assert.equal(mine.approvedAt, APPROVED.toISOString());
  assert.equal(mine.amendUntil, '2026-11-11T01:00:00.000Z', 'first approval + 24 hours; an amendment does not restart it');
  assert.equal(mine.amendedAt, AMENDED.toISOString());
  assert.equal(mine.addendumAt, null);
  assert.equal(mine.amendMine, true);
  assert.ok(!JSON.stringify(mine).includes('sub-approver'), 'the approver subject is not sent');
  assert.equal(values.toClient(s, r, { ...caller, sub: 'sub-other' }).amendMine, false);
  // An approval whose time is unknown has no window; it is not called past the window either.
  const unknown = values.toClient({ ...s, approvedAt: null, approvedBySub: null, amendedAt: null }, r, caller);
  assert.deepEqual([unknown.approvedAt, unknown.amendUntil, unknown.amendedAt, unknown.amendMine], [null, null, null, false]);
  // Outside RS A the round does not exist on the screen.
  const open = values.toClient({ ...s, rs: 'W' }, r, caller);
  assert.deepEqual([open.approvedAt, open.amendUntil, open.amendedAt, open.addendumAt, open.amendMine], [null, null, null, null, false]);
  assert.equal(values.amendUntil(APPROVED).toISOString(), '2026-11-11T01:00:00.000Z');
  assert.equal(values.amendUntil(null), null);
});
