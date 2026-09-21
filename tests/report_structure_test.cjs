// TEST-S3-STRUCT-BACKEND: the compiled structured-entry rules, the three write paths and the read.
//
// Runs against the built image (/app/dist) exactly like report_citation_test.cjs:
//   docker run --rm --network none --read-only -v "$PWD/tests:/tests:ro" \
//     --entrypoint node kin-api:ci --test /tests/report_structure_test.cjs
// Every database call is a stub, so no Postgres, no Orthanc and no original data.
//
// These are DIRECT assertions, not mutants. P4: the server rules of this unit are proved here by
// driving the compiled service, and the six executed mutants are all client-side. Nothing in this
// file may ever be reported as a "kill".
//
// What this file does NOT prove: that PostgreSQL raises the CHECK carrying the constraint name, and
// that canonical jsonb bytes are what the real database measures. Both are real-database facts; the
// mapping is pinned here on a synthesized error so a rename or a broadened catch is caught early.
const test = require('node:test'), assert = require('node:assert/strict');
const { PacsService } = require('/app/dist/pacs.service');
const structure = require('/app/dist/report-structure');
const { Prisma } = require('/app/node_modules/@prisma/client');
const vectors = require('/tests/report_structure_vectors.json');

const UID = '2.25.4242';
const CALLER = { kind: 'member', institution: 'synthetic', sub: 'sub-1', actor: 'doctor@synthetic', roles: ['radiologist'] };
const ADMIN = { kind: 'member', institution: 'synthetic', sub: 'sub-9', actor: 'admin@synthetic', roles: ['admin'] };
const STATE = { uid: UID, institutionId: 'synthetic', teleInstitutionId: null, rs: 'T', ss: 'Verified', em: 'N',
  holder: null, heldAt: null, preDoc: null, preReviewer: null, repDoc: null, confirm: null };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const CATALOG = vectors.catalog;
const TEMPLATE = CATALOG[0];
const item = code => TEMPLATE.items.find(i => i.code === code);
const CHOICE_LINE = 'SYNTHETIC-ITEM choice = alpha';
const CHOICE_LINE2 = 'SYNTHETIC-ITEM choice = beta';
const NUMBER_LINE = 'SYNTHETIC-ITEM number = 12.0 unit-x';
const NUMBER_15 = 'SYNTHETIC-ITEM number = 15.0 unit-x';
const NUMBER_18 = 'SYNTHETIC-ITEM number = 18.0 unit-x';

const apply = (over = {}) => ({ op: 'apply', field: 'findings', templateId: 'SYN-T1', templateRevision: 2,
  itemCode: 'SYN-CHOICE', valueType: 'choice', value: 'c1', renderedText: CHOICE_LINE, ...over });

const stored = (over = {}) => ({ v: 1, sid: 's-head', field: 'findings', templateId: 'SYN-T1',
  templateRevision: 2, itemCode: 'SYN-CHOICE', valueType: 'choice', value: 'c1', unit: null,
  renderedText: CHOICE_LINE, enteredAt: '2026-09-01T00:00:00.000Z', enteredBy: 'other@synthetic', ...over });

const body = (over = {}) => ({ findings: CHOICE_LINE, conclusion: '', recommendation: '', baseVersion: 4, ...over });

function fixture({ state = STATE,
  report = { version: 4, updatedBy: 'doctor2@synthetic', findings: CHOICE_LINE, conclusion: '', recommendation: '' },
  versions = new Map(), draft = null, drafts = null, bytes = null, failWith = null, catalog = CATALOG,
  createManyFails = [] } = {}) {
  const writes = [], audits = [], raw = [], created = [];
  // Successive answers for reportVersion.createMany, so the forced-release RETRY leg can be driven:
  // [P2002, CHECK] makes the first attempt lose the version race and the second raise our CHECK.
  const manyFails = createManyFails.slice();
  const draftRaw = () => (draft ? [{ citations: draft.citations ?? null, structured: draft.structured ?? null }] : []);
  const tx = {
    $executeRaw: async () => 0,
    $queryRaw: async (strings, ...values) => {
      const sql = strings.join('?').replace(/\s+/g, ' ').trim();
      raw.push(sql);
      if (sql.includes('FROM "StudyState"')) return state ? [state] : [];
      if (sql.includes('FROM "Report" WHERE')) return report ? [report] : [];
      if (sql.includes('SELECT uid, author')) return drafts ?? [];
      if (sql.includes('FROM "ReportDraft"')) return draftRaw();
      if (sql.includes('octet_length')) return [{ bytes: bytes ?? Buffer.byteLength(String(values[0] ?? ''), 'utf8') }];
      throw new Error('unexpected raw query: ' + sql);
    },
    studyState: { findUnique: async () => state, update: async () => { writes.push('studyState.update'); return state; } },
    report: {
      findUnique: async a => (report ? (a?.select?.findings ? report : { version: report.version }) : null),
      upsert: async a => writes.push('report.upsert:v' + a.create.version),
    },
    reportDraft: {
      findUnique: async () => draft,
      upsert: async a => {
        if (failWith) throw failWith;
        writes.push('reportDraft.upsert');
        created.push({ call: 'draft', create: a.create, update: a.update });
        return { uid: UID, author: CALLER.actor, baseVersion: a.update.baseVersion, updatedAt: 'now' };
      },
      deleteMany: async () => { writes.push('reportDraft.deleteMany'); return { count: draft ? 1 : 0 }; },
    },
    reportVersion: {
      findFirst: async () => { const all = [...versions.keys()]; return all.length ? { version: Math.max(...all) } : null; },
      findUnique: async a => (a.where.uid_version.uid === UID ? versions.get(a.where.uid_version.version) : null) ?? null,
      create: async a => { if (failWith) throw failWith;
        writes.push(`reportVersion.create:v${a.data.version}:${a.data.action}`); created.push({ call: 'version', data: a.data }); },
      createMany: async a => { const boom = manyFails.shift(); if (boom) throw boom;
        writes.push('reportVersion.createMany'); created.push({ call: 'many', data: a.data }); },
    },
    auditLog: { create: async a => { audits.push(a.data); return a.data; } },
  };
  const prisma = {
    $transaction: async work => work(tx),
    studyState: { findUnique: async () => state },
    report: { findUnique: async () => report },
    reportDraft: { findUnique: async () => draft },
    auditLog: { create: async a => { audits.push(a.data); return a.data; } },
  };
  const studyAccess = { prepare: async () => {}, require: async () => {}, allowed: async () => new Set() };
  const findings = { readableFindings: async () => [] };
  const svc = new PacsService(prisma, {}, { usersInGroupWithRole: async () => [] }, studyAccess, findings);
  // P7: the ONLY injection seam. No env var, no header, no route - a test overwrites the field on
  // its own instance, and the product instance keeps the empty constant.
  svc.structureCatalog = catalog;
  return { svc, writes, audits, raw, created, tx };
}

const checkError = name => Object.assign(
  new Error(`new row violates check constraint "${name}"`), { code: 'P2010' });

const refusal = async (promise, status) => {
  const e = await promise.then(() => null, error => error);
  assert.ok(e, 'expected a refusal');
  assert.equal(typeof e.getStatus === 'function' ? e.getStatus() : 0, status, e.message);
  const answer = typeof e.getResponse === 'function' ? e.getResponse() : null;
  return (answer && typeof answer === 'object') ? answer : { message: e.message };
};

/* ── the pure rules, as compiled ─────────────────────────────────────────────────────────── */

test('the shipped product catalog is empty and refuses every apply', async () => {
  assert.deepEqual([...structure.STRUCTURE_CATALOG], []);
  const { svc, writes } = fixture({ catalog: structure.STRUCTURE_CATALOG });
  const answer = await refusal(svc.putReport(UID, { ...body(), structure: apply() }, CALLER), 400);
  assert.match(String(answer.message), /서식을 찾을 수 없습니다/);
  assert.deepEqual(writes, []);
});

test('renderItem reproduces every shared vector byte for byte', () => {
  for (const vector of vectors.render)
    assert.equal(structure.renderItem(item(vector.itemCode), vector.value), vector.rendered);
});

test('validateValue refuses every shared invalid vector', () => {
  for (const vector of vectors.invalid)
    assert.throws(() => structure.validateValue(item(vector.itemCode), vector.value),
      structure.StructureInputError, vector.why);
});

test('the input reader keeps nine keys and drops everything the server owns', () => {
  const read = structure.structureApplyInput({ ...apply(),
    sid: 'forged', enteredBy: 'forged@synthetic', enteredAt: '1999-01-01T00:00:00.000Z',
    unit: 'forged-unit', v: 99, state: 'present', sameTextCount: 7 }, CATALOG);
  assert.deepEqual(Object.keys(read).sort(),
    ['field', 'itemCode', 'op', 'renderedText', 'replacesSid', 'templateId', 'templateRevision', 'value', 'valueType']);
  assert.equal(read.replacesSid, null);
});

test('the input reader refuses a stale revision, a foreign item and a mismatched field or type', () => {
  const cases = [
    [{ templateRevision: 1 }, /서식이 그 사이 바뀌었습니다/],
    [{ templateId: 'SYN-GONE' }, /서식을 찾을 수 없습니다/],
    [{ itemCode: 'SYN-GONE' }, /항목을 찾을 수 없습니다/],
    [{ field: 'conclusion' }, /들어갈 칸이 아닙니다/],
    [{ valueType: 'text' }, /valueType이 서식과 다릅니다/],
  ];
  for (const [over, pattern] of cases)
    assert.throws(() => structure.structureApplyInput(apply(over), CATALOG), pattern);
});

test('the server chooses the sentence: a renderedText the catalog would not produce is refused', () => {
  assert.throws(() => structure.structureApplyInput(apply({ renderedText: CHOICE_LINE + ' (edited)' }), CATALOG),
    /서식이 만드는 문장과 다릅니다/);
  assert.throws(() => structure.structureApplyInput(apply({ value: 'c2' }), CATALOG),
    /서식이 만드는 문장과 다릅니다/);
});

test('replace needs a sid and apply may not carry one', () => {
  assert.throws(() => structure.structureApplyInput(apply({ op: 'replace' }), CATALOG), /replacesSid가 필요합니다/);
  assert.throws(() => structure.structureApplyInput(apply({ replacesSid: 's-1' }), CATALOG), /apply에는 replacesSid/);
  assert.equal(structure.structureApplyInput(apply({ op: 'replace', replacesSid: 's-1' }), CATALOG).replacesSid, 's-1');
});

test('the keep list means no-change, clear-mine and ignore-unknown', () => {
  const entries = [stored({ sid: 'a' }), stored({ sid: 'b' })];
  assert.deepEqual(structure.applyStructureKeepList(entries, undefined).kept.map(e => e.sid), ['a', 'b']);
  assert.deepEqual(structure.applyStructureKeepList(entries, []).kept, []);
  const some = structure.applyStructureKeepList(entries, ['b', 'ghost']);
  assert.deepEqual(some.kept.map(e => e.sid), ['b']);
  assert.equal(some.ignored, 1);
  assert.throws(() => structure.structureIdList('nope', 'structureIds'), structure.StructureInputError);
});

test('commit selection applies ONE presence rule to head and draft alike', () => {
  // B1/P1. Without this, a hand-edited sentence keeps the old typed value on the signed version.
  const head = stored({ sid: 's-head' });
  const mine = stored({ sid: 's-mine', renderedText: NUMBER_LINE, itemCode: 'SYN-NUMBER' });
  const content = { findings: NUMBER_LINE, conclusion: '', recommendation: '' };
  const picked = structure.commitStructureSelection([head, mine], content, false, false);
  assert.deepEqual(picked.entries.map(e => e.sid), ['s-mine']);
  assert.deepEqual(picked.dropped, ['s-head']);
  const both = structure.commitStructureSelection([head, mine],
    { findings: CHOICE_LINE + '\n' + NUMBER_LINE, conclusion: '', recommendation: '' }, false, false);
  assert.deepEqual(both.entries.map(e => e.sid), ['s-head', 's-mine']);
  assert.deepEqual(both.dropped, []);
  /**
   * B6: the MIRROR case, and the only one that can tell this rule from the original head-only
   * filter. Here the head sentence is present and MY OWN draft sentence is the one the reader
   * edited away. A filter that trusted draft entries would sign `12.0` onto a report that says
   * `15.0` - the machine-readable value contradicting the record.
   */
  const mineGone = structure.commitStructureSelection([head, mine],
    { findings: CHOICE_LINE, conclusion: '', recommendation: '' }, false, false);
  assert.deepEqual(mineGone.entries.map(e => e.sid), ['s-head']);
  assert.deepEqual(mineGone.dropped, ['s-mine']);
});

test('B6 a draft entry whose sentence the reader edited away is dropped by save AND by approve', async () => {
  // Compiled, through the real commitReport, for both actions that write a version row.
  const EDITED = 'SYNTHETIC-ITEM number = 15.0 unit-x';
  for (const action of ['save', 'approve']) {
    const { svc, created, audits } = fixture({
      draft: { structured: [stored({ sid: 's-mine', itemCode: 'SYN-NUMBER', renderedText: NUMBER_LINE })] } });
    await svc.commitReport(UID, { action, baseVersion: 4, findings: EDITED,
      conclusion: '', recommendation: '', structureIds: ['s-mine'] }, CALLER);
    const version = created.find(c => c.call === 'version');
    assert.equal('structured' in version.data, false,
      `${action}: the edited-away entry must not reach the signed row`);
    const audit = audits.find(a => String(a.action).startsWith('report.' + action));
    const detail = JSON.parse(JSON.stringify(audit.detail));
    assert.deepEqual(detail.strs.dropped, ['s-mine'], `${action}: the dropped sid must be named`);
    assert.equal(detail.strs.n, 0);
  }
});

test('a blank body and a reset carry nothing and say so', () => {
  const entries = [stored({ sid: 'a' }), stored({ sid: 'b' })];
  for (const [blank, reset] of [[true, false], [false, true]]) {
    const picked = structure.commitStructureSelection(entries, { findings: CHOICE_LINE }, blank, reset);
    assert.deepEqual(picked.entries, []);
    assert.deepEqual(picked.dropped, ['a', 'b']);
  }
});

test('the union is head first and the immutable head wins a sid collision', () => {
  const union = structure.structureUnion([stored({ sid: 'x', value: 'c1' })],
    [stored({ sid: 'x', value: 'c2' }), stored({ sid: 'y' })]);
  assert.deepEqual(union.map(e => e.sid), ['x', 'y']);
  assert.equal(union[0].value, 'c1');
});

test('a malformed stored entry is recognised, and counts use the citation equation', () => {
  assert.equal(structure.isStructureEntry(stored()), true);
  for (const bad of [null, 'text', {}, stored({ sid: '' }), stored({ field: 'nope' }),
    stored({ valueType: 'nope' }), stored({ renderedText: '' })])
    assert.equal(structure.isStructureEntry(bad), false);
  assert.deepEqual(structure.structureSameTextCounts([stored({ sid: 'a' }), stored({ sid: 'b' }),
    stored({ sid: 'c', renderedText: NUMBER_LINE })]), [2, 2, 1]);
});

test('validateCatalog accepts the synthetic catalog and refuses ambiguity', () => {
  structure.validateCatalog(CATALOG);
  structure.validateCatalog(structure.STRUCTURE_CATALOG);
  const clone = extra => [{ ...TEMPLATE, items: [...TEMPLATE.items, extra] }];
  assert.throws(() => structure.validateCatalog(clone({ ...item('SYN-CHOICE') })), /code가 중복/);
  assert.throws(() => structure.validateCatalog(clone({ ...item('SYN-TEXT'), code: 'SYN-X' })), /골격이 중복/);
  assert.throws(() => structure.validateCatalog(clone({ ...item('SYN-CHOICE'), code: 'SYN-X' })), /같은 문장을 만듭니다/);
  assert.throws(() => structure.validateCatalog(clone({ ...item('SYN-TEXT'), code: 'SYN-X', template: 'no slot' })),
    /정확히 한 번/);
});

/* ── the draft write ─────────────────────────────────────────────────────────────────────── */

test('an apply stores the value, the sentence and the attestation the server owns', async () => {
  const { svc, created } = fixture();
  const answer = await svc.putReport(UID, { ...body(), structure: apply() }, CALLER);
  const written = created.find(c => c.call === 'draft').create.structured;
  assert.equal(written.length, 1);
  assert.match(written[0].sid, UUID);
  assert.equal(written[0].enteredBy, CALLER.actor);
  assert.equal(written[0].value, 'c1');
  assert.equal(written[0].renderedText, CHOICE_LINE);
  assert.equal(written[0].v, 1);
  // P9: the answer carries the sid and nothing else new.
  assert.deepEqual(Object.keys(answer.structured).sort(), ['enteredAt', 'field', 'sid']);
  assert.equal(answer.structured.sid, written[0].sid);
});

test('an apply whose sentence is not in this request body is refused and writes nothing', async () => {
  const { svc, writes } = fixture();
  const answer = await refusal(
    svc.putReport(UID, { ...body({ findings: 'typed something else' }), structure: apply() }, CALLER), 409);
  assert.equal(answer.code, 'REPORT_STRUCTURE_TEXT');
  assert.deepEqual(writes, []);
});

test('an empty body carrying an apply is refused rather than silently ignored', async () => {
  const { svc, writes } = fixture();
  const answer = await refusal(svc.putReport(UID,
    { findings: '', conclusion: '', recommendation: '', baseVersion: 4, structure: apply() }, CALLER), 409);
  assert.equal(answer.code, 'REPORT_STRUCTURE_TEXT');
  assert.deepEqual(writes, []);
});

test('the same item cannot be entered twice; the second apply says to use replace', async () => {
  const { svc } = fixture({ draft: { structured: [stored({ sid: 's-mine' })] } });
  const answer = await refusal(svc.putReport(UID, { ...body(), structure: apply() }, CALLER), 409);
  assert.equal(answer.code, 'REPORT_STRUCTURE_EXISTS');
});

test('replace can address a HEAD entry, which is what makes the value editable after a Save', async () => {
  // B3/P3: the draft row is deleted at every commit, so after one Save every entry is a head entry.
  const versions = new Map([[4, { structured: [stored({ sid: 's-head' })] }]]);
  const { svc, created } = fixture({ versions,
    report: { version: 4, findings: CHOICE_LINE2, conclusion: '', recommendation: '' } });
  await svc.putReport(UID, { ...body({ findings: CHOICE_LINE2 }),
    structure: apply({ op: 'replace', replacesSid: 's-head', value: 'c2', renderedText: CHOICE_LINE2 }) }, CALLER);
  const written = created.find(c => c.call === 'draft').create.structured;
  assert.equal(written.length, 1, 'the head row is immutable: only the new draft entry is written');
  assert.equal(written[0].value, 'c2');
  assert.notEqual(written[0].sid, 's-head');
});

test('replace is refused while the old sentence is still in the body', async () => {
  const versions = new Map([[4, { structured: [stored({ sid: 's-head' })] }]]);
  const { svc, writes } = fixture({ versions });
  const answer = await refusal(svc.putReport(UID, { ...body({ findings: CHOICE_LINE + '\n' + CHOICE_LINE2 }),
    structure: apply({ op: 'replace', replacesSid: 's-head', value: 'c2', renderedText: CHOICE_LINE2 }) },
    CALLER), 409);
  assert.equal(answer.code, 'REPORT_STRUCTURE_REPLACE');
  assert.deepEqual(writes, []);
});

test('replace refuses a sid that is neither mine nor the head, and a different item', async () => {
  const versions = new Map([[4, { structured: [stored({ sid: 's-head' })] }]]);
  const { svc } = fixture({ versions, report: { version: 4, findings: CHOICE_LINE2, conclusion: '', recommendation: '' } });
  const gone = await refusal(svc.putReport(UID, { ...body({ findings: CHOICE_LINE2 }),
    structure: apply({ op: 'replace', replacesSid: 'ghost', value: 'c2', renderedText: CHOICE_LINE2 }) }, CALLER), 409);
  assert.equal(gone.code, 'REPORT_STRUCTURE_REPLACE');
  const other = await refusal(svc.putReport(UID, { ...body({ findings: NUMBER_LINE }),
    structure: { op: 'replace', replacesSid: 's-head', field: 'findings', templateId: 'SYN-T1',
      templateRevision: 2, itemCode: 'SYN-NUMBER', valueType: 'number', value: 12, renderedText: NUMBER_LINE } },
    CALLER), 409);
  assert.equal(other.code, 'REPORT_STRUCTURE_REPLACE');
  assert.match(String(other.message), /같은 서식의 같은 항목/);
});

/* ── A1: omission is not a clear ─────────────────────────────────────────────────────────── */

test('A1 an explicit empty keep list clears the column to SQL NULL, never by omission', async () => {
  const { svc, created } = fixture({ draft: { structured: [stored({ sid: 's-mine' })] } });
  await svc.putReport(UID, { ...body(), structureIds: [] }, CALLER);
  const write = created.find(c => c.call === 'draft');
  assert.equal(write.update.structured, Prisma.DbNull, 'an UPDATE must say NULL out loud');
  assert.notEqual(write.update.structured, null, 'a JS null would be the Prisma JSON-null trap');
  assert.equal('structured' in write.create, false, 'CREATE has nothing to clear, so it omits');
});

test('A1 a request that does not mention structure leaves the column untouched', async () => {
  const { svc, created, raw } = fixture({ draft: { structured: [stored({ sid: 's-mine' })] } });
  await svc.putReport(UID, body(), CALLER);
  const write = created.find(c => c.call === 'draft');
  assert.equal('structured' in write.update, false, 'omission is "leave it alone"');
  assert.equal('structured' in write.create, false);
  assert.equal(raw.some(sql => sql.startsWith('SELECT structured')), false,
    'a legacy write must not even read the column');
});

test('A1 a keep list that keeps something still writes the array', async () => {
  const { svc, created } = fixture({ draft: { structured: [stored({ sid: 'a' }), stored({ sid: 'b' })] } });
  await svc.putReport(UID, { ...body(), structureIds: ['a'] }, CALLER);
  const write = created.find(c => c.call === 'draft');
  assert.deepEqual(write.update.structured.map(e => e.sid), ['a']);
  assert.deepEqual(write.create.structured.map(e => e.sid), ['a']);
});

test('a structureIds-only request gets no structured key in the answer', async () => {
  // P9: the key exists only when the request carried `structure`.
  const { svc } = fixture({ draft: { structured: [stored({ sid: 'a' })] } });
  const answer = await svc.putReport(UID, { ...body(), structureIds: ['a'] }, CALLER);
  assert.equal('structured' in answer, false);
});

test('the draft audit carries counts and sids only', async () => {
  const { svc, audits } = fixture();
  await svc.putReport(UID, { ...body(), structure: apply() }, CALLER);
  const entry = audits.find(a => a.action === 'report.draft');
  const detail = JSON.stringify(entry.detail);
  assert.match(detail, /"strs"/);
  assert.equal(detail.includes(CHOICE_LINE), false, 'the sentence must not reach the audit trail');
  assert.equal(detail.includes('SYN-CHOICE'), false, 'nor the item code');
  assert.equal(detail.includes('"c1"'), false, 'nor the value');
});

/* ── commit, reset and force discard ─────────────────────────────────────────────────────── */

test('commit keeps only the entries whose sentence is in the signed body, and names the dropped', async () => {
  const versions = new Map([[4, { structured: [stored({ sid: 's-head' })] }]]);
  const { svc, created, audits } = fixture({ versions,
    draft: { structured: [stored({ sid: 's-mine', itemCode: 'SYN-NUMBER', renderedText: NUMBER_LINE })] } });
  await svc.commitReport(UID, { action: 'save', baseVersion: 4, findings: NUMBER_LINE,
    conclusion: '', recommendation: '', structureIds: ['s-mine'] }, CALLER);
  const version = created.find(c => c.call === 'version');
  assert.deepEqual(version.data.structured.map(e => e.sid), ['s-mine']);
  const audit = audits.find(a => String(a.action).startsWith('report.save'));
  const detail = JSON.parse(JSON.stringify(audit.detail));
  assert.deepEqual(detail.strs.dropped, ['s-head']);
  assert.equal(detail.strs.n, 1);
  assert.equal(JSON.stringify(detail).includes(NUMBER_LINE), false);
});

test('commit never writes an empty array - it omits the column', async () => {
  const { svc, created } = fixture();
  await svc.commitReport(UID, { action: 'save', baseVersion: 4, findings: 'plain text',
    conclusion: '', recommendation: '' }, CALLER);
  const version = created.find(c => c.call === 'version');
  assert.equal('structured' in version.data, false, 'no entries has exactly one shape: absent');
});

test('reset carries the head entries onto the preserved row and signs an empty new one', async () => {
  const versions = new Map([[4, { structured: [stored({ sid: 's-head' })] }]]);
  const { svc, created } = fixture({ versions });
  await svc.commitReport(UID, { action: 'reset', reason: '재판독', baseVersion: 4,
    findings: '', conclusion: '', recommendation: '' }, CALLER);
  const rows = created.filter(c => c.call === 'version');
  const discarded = rows.find(r => r.data.action === 'discarded');
  assert.deepEqual(discarded.data.structured.map(e => e.sid), ['s-head']);
  const head = rows.find(r => r.data.action === 'reset');
  assert.equal('structured' in head.data, false);
});

test('force discard preserves the typed evidence with the body, and omits it when there is none', async () => {
  // B2/P2: the third writer of draft->version rows. Without this the admin path keeps the sentence
  // and destroys what it meant.
  const drafts = [
    { uid: UID, author: 'a@synthetic', findings: CHOICE_LINE, conclusion: '', recommendation: '',
      baseVersion: 4, citations: null, structured: [stored({ sid: 's-a' })], updatedAt: 'now' },
    { uid: UID, author: 'b@synthetic', findings: 'plain', conclusion: '', recommendation: '',
      baseVersion: 4, citations: null, structured: null, updatedAt: 'now' },
  ];
  const { svc, created, raw } = fixture({ drafts });
  await svc.forceDiscardDrafts(UID, ADMIN);
  const many = created.find(c => c.call === 'many').data;
  assert.deepEqual(many[0].structured.map(e => e.sid), ['s-a']);
  assert.equal('structured' in many[1], false, 'a NULL read back must be omitted, not passed through');
  assert.ok(raw.some(sql => sql.includes('SELECT uid, author') && sql.includes('structured')),
    'the raw SELECT must name the column or it can never be copied');
});

/* ── limits and the read ─────────────────────────────────────────────────────────────────── */

test('B1 the forced release maps our CHECK on the first leg and on the P2002 retry leg', async () => {
  /**
   * This is the path the candidate could not even compile: forceDiscardDrafts wraps BOTH its first
   * attempt and its version-race retry in the same limit mapping. A CHECK raised by the retry would
   * otherwise leave as a 500, and the same request would have two different answers.
   */
  const drafts = [{ uid: UID, author: 'a@synthetic', findings: CHOICE_LINE, conclusion: '', recommendation: '',
    baseVersion: 4, citations: null, structured: [stored({ sid: 's-a' })], updatedAt: 'now' }];
  const legs = {
    'first leg': [checkError('ReportVersion_structured_check')],
    'P2002 retry leg': [Object.assign(new Error('unique'), { code: 'P2002' }),
                        checkError('ReportVersion_structured_check')],
  };
  for (const [name, fails] of Object.entries(legs)) {
    const { svc } = fixture({ drafts, createManyFails: fails });
    const answer = await refusal(svc.forceDiscardDrafts(UID, ADMIN), 409);
    assert.equal(answer.code, 'REPORT_STRUCTURE_LIMIT', name);
  }
  // A version race with no CHECK behind it still succeeds on the retry, unchanged.
  const { svc, created } = fixture({ drafts,
    createManyFails: [Object.assign(new Error('unique'), { code: 'P2002' })] });
  const ok = await svc.forceDiscardDrafts(UID, ADMIN);
  assert.equal(ok.count, 1);
  assert.deepEqual(created.find(c => c.call === 'many').data[0].structured.map(e => e.sid), ['s-a']);
});

test('B3 a superseded head entry is not live, so the same item can be changed again', async () => {
  /**
   * Save (sid1) -> replace to sid2 -> change again BEFORE the next commit. sid1 is still on the
   * immutable head row, but its sentence left the body when sid2 replaced it. Counting it as live
   * answered "이미 입력한 항목입니다 - 값을 바꾸려면 수정을 사용하세요" to a reader who was doing
   * exactly that, and only a commit could get out of it.
   */
  const num = over => stored({ itemCode: 'SYN-NUMBER', valueType: 'number', ...over });
  const versions = new Map([[4, { structured: [num({ sid: 's1', value: 12, renderedText: NUMBER_LINE })] }]]);
  const { svc, created } = fixture({ versions,
    report: { version: 4, findings: NUMBER_15, conclusion: '', recommendation: '' },
    draft: { structured: [num({ sid: 's2', value: 15, renderedText: NUMBER_15 })] } });
  await svc.putReport(UID, { ...body({ findings: NUMBER_18 }), structureIds: ['s2'],
    structure: { op: 'replace', replacesSid: 's2', field: 'findings', templateId: 'SYN-T1',
      templateRevision: 2, itemCode: 'SYN-NUMBER', valueType: 'number', value: 18,
      renderedText: NUMBER_18 } }, CALLER);
  const written = created.find(c => c.call === 'draft').update.structured;
  assert.equal(written.length, 1, 's2 is gone and exactly the new entry remains');
  assert.equal(written[0].value, 18);
  assert.equal(written.some(e => e.sid === 's1' || e.sid === 's2'), false);
});

test('B3 a head entry whose sentence IS in the body still blocks a second apply', async () => {
  // The narrowing must not become a licence to enter the same item twice.
  const versions = new Map([[4, { structured: [stored({ sid: 's1', renderedText: CHOICE_LINE })] }]]);
  const { svc, writes } = fixture({ versions });
  const answer = await refusal(svc.putReport(UID, { ...body({ findings: CHOICE_LINE }), structure: apply() },
    CALLER), 409);
  assert.equal(answer.code, 'REPORT_STRUCTURE_EXISTS');
  assert.deepEqual(writes, []);
});

test('our CHECK name becomes a named 409 on the draft path and on commit', async () => {
  for (const [name, run] of [
    ['ReportDraft_structured_check', ({ svc }) => svc.putReport(UID, { ...body(), structure: apply() }, CALLER)],
    ['ReportVersion_structured_check', ({ svc }) => svc.commitReport(UID,
      { action: 'save', baseVersion: 4, findings: CHOICE_LINE, conclusion: '', recommendation: '' }, CALLER)],
  ]) {
    const f = fixture({ failWith: checkError(name) });
    const answer = await refusal(run(f), 409);
    assert.equal(answer.code, 'REPORT_STRUCTURE_LIMIT', name);
  }
  // A database error that is not ours is not disguised as a limit.
  const other = fixture({ failWith: Object.assign(new Error('connection reset'), { code: 'P1001' }) });
  const e = await other.svc.putReport(UID, { ...body(), structure: apply() }, CALLER).then(() => null, x => x);
  assert.equal(e.code, 'P1001');
});

test('too many entries are refused before the database is asked', async () => {
  const many = Array.from({ length: 64 }, (_, i) => stored({ sid: 's' + i, itemCode: 'SYN-' + i }));
  const { svc } = fixture({ draft: { structured: many } });
  const answer = await refusal(svc.putReport(UID, { ...body({ findings: NUMBER_LINE }),
    structure: apply({ itemCode: 'SYN-NUMBER', valueType: 'number', value: 12, renderedText: NUMBER_LINE }) },
    CALLER), 409);
  assert.equal(answer.code, 'REPORT_STRUCTURE_LIMIT');
});

test('the read answers head and draft with a presence state computed now', async () => {
  const versions = new Map([[4, { structured: [stored({ sid: 's-head' })] }]]);
  const { svc } = fixture({ versions,
    draft: { findings: NUMBER_LINE, conclusion: '', recommendation: '',
      structured: [stored({ sid: 's-mine', itemCode: 'SYN-NUMBER', renderedText: NUMBER_LINE })] } });
  const answer = await svc.reportStructure(UID, CALLER);
  assert.equal(answer.version, 4);
  assert.equal(answer.unknown, false);
  assert.equal(answer.head[0].state, 'present');
  assert.equal(answer.draft[0].state, 'present');
  assert.equal(answer.head[0].sameTextCount, 1);
});

test('a sentence the reader deleted reads as absent, not as a lie', async () => {
  const versions = new Map([[4, { structured: [stored({ sid: 's-head' })] }]]);
  const { svc } = fixture({ versions, report: { version: 4, findings: 'reader rewrote this', conclusion: '', recommendation: '' } });
  const answer = await svc.reportStructure(UID, CALLER);
  assert.equal(answer.head[0].state, 'absent');
});

test('one malformed stored entry makes the whole answer unknown', async () => {
  const versions = new Map([[4, { structured: [stored({ sid: 's-head' }), { sid: 'x', field: 'nope' }] }]]);
  const { svc } = fixture({ versions });
  const answer = await svc.reportStructure(UID, CALLER);
  assert.equal(answer.unknown, true);
  assert.equal(answer.head, null);
  assert.equal(answer.draft, null);
});

test('the read keeps the preliminary and missing-study gates of the history read', async () => {
  const hidden = { ...STATE, rs: 'P', preReviewer: 'senior@synthetic', preDoc: 'junior@synthetic' };
  const { svc } = fixture({ state: hidden });
  await refusal(svc.reportStructure(UID, CALLER), 403);
  const gone = fixture({ state: null });
  await refusal(gone.svc.reportStructure(UID, CALLER), 404);
});
