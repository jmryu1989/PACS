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
const crypto = require('node:crypto');
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

/* ── the SHIPPED catalog, through the compiled server ────────────────────────────────────── */

const SHIPPED = structure.STRUCTURE_CATALOG;
const shippedItem = code => SHIPPED[0].items.find(i => i.code === code);
const shippedApply = (code, value, over = {}) => {
  const it = shippedItem(code);
  return { op: 'apply', field: it.field, templateId: 'GEN-1', templateRevision: 1, itemCode: code,
    valueType: it.valueType, value, renderedText: structure.renderItem(it, value), ...over };
};

test('the shipped catalog is GEN-1 revision 1 and every item renders its own sentence', () => {
  /**
   * First use. Until GEN-1 this constant was `[]`, so every apply was a 400 and none of the paths
   * below had ever been reachable in the product. The sentences are written out rather than derived
   * from the catalog - deriving them would only restate `renderItem`, and a wording change has to
   * be read by a human, because a wording change retires every sentence already signed under it.
   */
  assert.equal(SHIPPED.length, 1);
  assert.equal(SHIPPED[0].templateId, 'GEN-1');
  assert.equal(SHIPPED[0].revision, 1);
  assert.deepEqual(SHIPPED[0].items.map(i => [i.code, i.field, i.valueType]), [
    ['TECHNIQUE', 'findings', 'text'],
    ['CONTRAST', 'findings', 'boolean'],
    ['COMPARISON', 'findings', 'choice'],
    ['COMPARISON-STUDY', 'findings', 'text'],
    ['FINDING', 'findings', 'text'],
    ['CONCLUSION', 'conclusion', 'text'],
    ['RECOMMENDATION', 'recommendation', 'text'],
  ]);
  assert.equal(structure.renderItem(shippedItem('CONTRAST'), true), 'Contrast: administered');
  assert.equal(structure.renderItem(shippedItem('CONTRAST'), false), 'Contrast: not administered');
  assert.equal(structure.renderItem(shippedItem('COMPARISON'), 'none'), 'Comparison: no prior study available');
  assert.equal(structure.renderItem(shippedItem('COMPARISON'), 'prior'), 'Comparison: prior study reviewed');
  assert.equal(structure.renderItem(shippedItem('FINDING'), 'a line'), 'Finding: a line');
  assert.equal(structure.renderItem(shippedItem('CONCLUSION'), 'a line'), 'Conclusion: a line');
  assert.equal(structure.renderItem(shippedItem('RECOMMENDATION'), 'a line'), 'Recommendation: a line');
  // The catalog proposes no value of its own for the free-text items: every word is the reader's.
  for (const it of SHIPPED[0].items)
    if (it.valueType === 'text')
      assert.equal(it.choices === undefined && it.trueText === undefined, true, `${it.code} carries wording`);
});

test('every shipped item is accepted by the reader, in its own field', async () => {
  // Including conclusion and recommendation: the server is field-generic (`content[input.field]`),
  // and R15's first-use workflow needs a coded line in all three body fields, not only findings.
  const cases = [['TECHNIQUE', 'axial CT'], ['CONTRAST', true], ['CONTRAST', false],
    ['COMPARISON', 'none'], ['COMPARISON', 'prior'], ['COMPARISON-STUDY', 'CT 2025-03-11'],
    ['FINDING', 'a line the reader typed'], ['CONCLUSION', 'a line the reader typed'],
    ['RECOMMENDATION', 'a line the reader typed']];
  for (const [code, value] of cases) {
    const send = shippedApply(code, value);
    const read = structure.structureApplyInput(send, SHIPPED);
    assert.equal(read.value, value, `${code}: the value is stored exactly as given`);
    assert.equal(read.renderedText, send.renderedText, `${code}: and so is the sentence`);
    assert.equal(read.field, shippedItem(code).field);
    // and it reaches the draft write, in its own field, through the real service
    const content = { findings: '', conclusion: '', recommendation: '', baseVersion: 4 };
    content[read.field] = send.renderedText;
    const { svc, created } = fixture({ catalog: SHIPPED });
    await svc.putReport(UID, { ...content, structure: send }, CALLER);
    const [entry] = created.find(c => c.call === 'draft').update.structured;
    assert.equal(entry.itemCode, code);
    assert.equal(entry.templateId, 'GEN-1');
    assert.equal(entry.value, value);
    assert.equal(entry.renderedText, send.renderedText);
    assert.match(entry.sid, UUID);
  }
});

test('the shipped catalog refuses a stale revision, an unknown item, a wrong field and a re-worded sentence', () => {
  const cases = [
    [shippedApply('FINDING', 'x', { templateRevision: 2 }), /서식이 그 사이 바뀌었습니다/],
    [shippedApply('FINDING', 'x', { templateId: 'GEN-2' }), /서식을 찾을 수 없습니다/],
    [shippedApply('FINDING', 'x', { itemCode: 'IMPRESSION' }), /항목을 찾을 수 없습니다/],
    [shippedApply('FINDING', 'x', { field: 'conclusion' }), /들어갈 칸이 아닙니다/],
    [shippedApply('CONTRAST', true, { valueType: 'text' }), /valueType이 서식과 다릅니다/],
    [shippedApply('FINDING', 'x', { renderedText: 'Finding: x (edited)' }), /서식이 만드는 문장과 다릅니다/],
    // Built from a legal apply with the value swapped: rendering 'invented' would throw while the
    // case table was being built, before assert.throws could see it.
    [{ ...shippedApply('COMPARISON', 'none'), value: 'invented' }, /choice 값이 서식의 선택지에 없습니다/],
  ];
  for (const [send, pattern] of cases)
    assert.throws(() => structure.structureApplyInput(send, SHIPPED), pattern, JSON.stringify(send.itemCode));
});

test('the shipped limits refuse at the byte: the sentence, NUL and a lone surrogate', () => {
  /**
   * The three shapes the page does not stop, pinned where they ARE stopped.
   *
   * The browser measures the VALUE; the server measures the value and the rendered LINE. So a
   * 512-byte value under a 9-byte prefix is legal on the page and refused here - the named narrow
   * band of this unit, which is not closed by loosening either side. NUL never leaves the page
   * (it is below U+0020), but a lone surrogate does, and `storable()` is the only thing that stops
   * it before `jsonb` turns it into a 500.
   */
  const finding = shippedItem('FINDING');
  assert.equal(structure.utf8Bytes(structure.renderItem(finding, 'x'.repeat(512))), 521);
  assert.throws(() => structure.structureApplyInput(shippedApply('FINDING', 'x'.repeat(512)), SHIPPED),
    /문장이 512바이트를 넘습니다/, 'the value fits and the sentence does not');
  assert.equal(structure.validateValue(finding, 'x'.repeat(503)), 'x'.repeat(503));
  assert.throws(() => structure.validateValue(finding, '가'.repeat(171)), /512바이트를 넘습니다/);
  // From the code point: a raw NUL is invisible in a source file and turns it binary to git.
  assert.throws(() => structure.validateValue(finding, 'a' + String.fromCharCode(0) + 'b'),
    /한 줄이어야 합니다/);
  assert.throws(() => structure.validateValue(finding, 'a' + String.fromCharCode(0xd800) + 'b'),
    /잘못된 문자 인코딩입니다/, 'the page lets this through; this is where it stops');
});

test('a shipped sentence moved by hand into another field is dropped at commit', async () => {
  /**
   * Cross-field. `commitStructureSelection` judges `content[entry.field]` and nothing else, so a
   * line the reader cut out of Findings and pasted into Conclusion is NOT the entry's sentence any
   * more - the entry goes, the words stay. The mirror case matters as much: the same sentence
   * typed independently in another field does not make the entry ambiguous, because the presence
   * count is keyed by field.
   */
  const line = 'Finding: a line the reader typed';
  const entry = stored({ sid: 's-cross', templateId: 'GEN-1', templateRevision: 1, itemCode: 'FINDING',
    valueType: 'text', value: 'a line the reader typed', renderedText: line });
  const moved = structure.commitStructureSelection([entry],
    { findings: '', conclusion: line, recommendation: '' }, false, false);
  assert.deepEqual(moved.entries, []);
  assert.deepEqual(moved.dropped, ['s-cross']);
  const kept = structure.commitStructureSelection([entry],
    { findings: line, conclusion: line, recommendation: '' }, false, false);
  assert.deepEqual(kept.entries.map(e => e.sid), ['s-cross']);
  assert.deepEqual(structure.structureSameTextCounts([entry,
    { ...entry, sid: 's-other', field: 'conclusion' }]), [1, 1],
    'the same words in another field are another field, not a second candidate');
});

test('the shipped catalog survives a full save: the value reaches the signed row, the audit names no words', async () => {
  const line = 'Conclusion: a line the reader typed';
  const entry = stored({ sid: 's-conc', templateId: 'GEN-1', templateRevision: 1, itemCode: 'CONCLUSION',
    field: 'conclusion', valueType: 'text', value: 'a line the reader typed', renderedText: line });
  const { svc, created, audits } = fixture({ catalog: SHIPPED, draft: { structured: [entry] } });
  await svc.commitReport(UID, { action: 'save', baseVersion: 4, findings: '', conclusion: line,
    recommendation: '', structureIds: ['s-conc'] }, CALLER);
  const version = created.find(c => c.call === 'version');
  assert.deepEqual(version.data.structured.map(e => [e.itemCode, e.value]),
    [['CONCLUSION', 'a line the reader typed']], 'the typed value is on the signed row');
  const detail = JSON.parse(audits.find(a => String(a.action).startsWith('report.save')).detail);
  assert.equal(detail.strs.n, 1);
  assert.equal(String(audits.find(a => String(a.action).startsWith('report.save')).detail).includes(line), false,
    'the audit carries counts and sids, never the sentence');
});

/* ── the pure rules, as compiled ─────────────────────────────────────────────────────────── */

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
    // `AuditLog.detail` is `String?` and the service writes `dump()` = JSON.stringify, so the
    // stored value IS a JSON string. Parse it once, exactly as report_citation_test.cjs:295 does.
    const detail = JSON.parse(audit.detail);
    assert.deepEqual(detail.strs.dropped, ['s-mine'], `${action}: the dropped sid must be named`);
    assert.equal(detail.strs.n, 0);
    // The raw string is what a reader of /audit would see: no value, no sentence, no item code.
    const raw = String(audit.detail ?? '');
    assert.doesNotMatch(raw, /renderedText|itemCode|SYN-/, `${action}: only counts and sids`);
    assert.equal(raw.includes(NUMBER_LINE), false, `${action}: the sentence must not reach the audit`);
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

/* ── P12: the catalog rules, as compiled ─────────────────────────────────────────────────── */

const catalogRule = catalog => {
  try { structure.validateCatalog(catalog); return 'ACCEPT'; }
  catch (e) {
    // A rule-bearing error, or nothing. "Something threw" is not the assertion.
    assert.ok(e instanceof structure.StructureCatalogError, `not a catalog error: ${e && e.message}`);
    assert.ok(e.message.startsWith(e.rule + ': '), 'the message must name its own rule');
    return e.rule;
  }
};

test('every shared catalog vector gets exactly the rule it names', () => {
  // B6: the vectors are the subject. Asserting the RULE and not merely a throw means a validator
  // that refused everything, or refused the right catalogs for the wrong reason, fails here.
  assert.ok(vectors.catalogVectors.length >= 30, 'the shared catalog vectors are missing');
  for (const vector of vectors.catalogVectors)
    assert.equal(catalogRule(vector.catalog), vector.rule, `${vector.name} - ${vector.why}`);
  // and the two catalogs this repository actually ships with are both legal.
  assert.equal(catalogRule(CATALOG), 'ACCEPT');
  assert.equal(catalogRule(structure.STRUCTURE_CATALOG), 'ACCEPT');
});

test('a sparse array hole is refused with a rule, not with a TypeError', () => {
  /**
   * A JSON file cannot express `[a, , b]`, so this witness cannot live in the shared vector table.
   * A hand-written catalog can grow one from a single stray comma, and reading a hole gives
   * `undefined`. The browser test carries the same three shapes against its own validator - the two
   * must answer alike, because a catalog that boots the API but kills the page is worse than one
   * that boots neither.
   */
  const item = (code, template) => ({ code, field: 'findings', valueType: 'text', template, label: code });
  const tpl = (items, templateId = 'SYN-H') => ({ templateId, revision: 1, title: 'SYNTHETIC', items });
  const choiceItem = choices => ({ code: 'A', field: 'findings', valueType: 'choice',
    template: 'M: {value}', label: 'A', choices });

  assert.equal(catalogRule([tpl([item('A', 'Alpha: {value}')], 'SYN-H1'), ,
                            tpl([item('B', 'Beta: {value}')], 'SYN-H2')]), 'R-D', 'a hole between templates');
  assert.equal(catalogRule([tpl([item('A', 'Alpha: {value}'), , item('B', 'Beta: {value}')])]),
    'R-D', 'a hole between items');
  assert.equal(catalogRule([tpl([choiceItem([{ code: 'c0', text: 'alpha' }, ,
                                             { code: 'c1', text: 'beta' }])])]), 'R-D', 'a hole between choices');
  // Remove the hole and each one is legal, so the case is about the hole and nothing else.
  assert.equal(catalogRule([tpl([item('A', 'Alpha: {value}')], 'SYN-H1'),
                            tpl([item('B', 'Beta: {value}')], 'SYN-H2')]), 'ACCEPT');
  assert.equal(catalogRule([tpl([item('A', 'Alpha: {value}'), item('B', 'Beta: {value}')])]), 'ACCEPT');
  assert.equal(catalogRule([tpl([choiceItem([{ code: 'c0', text: 'alpha' },
                                             { code: 'c1', text: 'beta' }])])]), 'ACCEPT');
});

test('every shared entry vector is decided at apply time, after the sentence already matched', () => {
  /**
   * A free-text value is not in the catalog, so the load-time pass can never see it. These go
   * through the real `structureApplyInput`, whose byte-equality check runs FIRST - so a refusal
   * here is the boundary rule and not "that is not the sentence this template makes". The message
   * is matched for that reason.
   */
  assert.ok(vectors.entryVectors.length >= 10, 'the shared entry vectors are missing');
  for (const vector of vectors.entryVectors) {
    const template = vector.catalog.find(t => t.templateId === vector.templateId);
    const entryItem = template.items.find(i => i.code === vector.itemCode);
    const send = { op: 'apply', field: entryItem.field, templateId: vector.templateId,
      templateRevision: template.revision, itemCode: vector.itemCode, valueType: entryItem.valueType,
      value: vector.value, renderedText: structure.renderItem(entryItem, vector.value) };
    if (vector.expect === 'ACCEPT') {
      const read = structure.structureApplyInput(send, vector.catalog);
      assert.equal(read.value, vector.value, `${vector.name}: the value is stored exactly as typed`);
      assert.equal(read.renderedText, send.renderedText, `${vector.name}: and so is the sentence`);
    } else {
      assert.throws(() => structure.structureApplyInput(send, vector.catalog),
        /값이 문장의 경계에서 합쳐져/, `${vector.name} - ${vector.why}`);
    }
  }
});

test('the injection seam validates BEFORE it replaces, so a refused catalog changes nothing', () => {
  // B4/P7. The seam stays the only way in, and now it is a gate. A setter that assigned first and
  // validated after would leave the service holding a catalog nobody checked.
  const { svc } = fixture();
  assert.deepEqual([...svc.structureCatalog], [...CATALOG]);
  const bad = vectors.catalogVectors.find(v => v.rule === 'R-B');
  assert.throws(() => { svc.structureCatalog = bad.catalog; }, structure.StructureCatalogError);
  assert.deepEqual([...svc.structureCatalog], [...CATALOG], 'the previous valid catalog still stands');
  const good = vectors.catalogVectors.find(v => v.rule === 'ACCEPT'
    && v.catalog.length === 1 && v.catalog[0].templateId !== TEMPLATE.templateId);
  svc.structureCatalog = good.catalog;
  assert.deepEqual([...svc.structureCatalog], [...good.catalog], 'a valid catalog does replace it');
  /**
   * And a fresh product instance still holds the catalog the MODULE ships - not the synthetic one
   * this test injected into `svc`. That is the half of "a valid catalog does replace it" that says
   * *only that instance*: if the setter wrote to anything shared, `good.catalog` would show up
   * here and this comparison would fail.
   *
   * Compared against `structure.STRUCTURE_CATALOG` itself rather than against a literal. A literal
   * went stale the day GEN-1 shipped and would go stale again at every revision; and a mere
   * "non-empty" check would pass even while an injected catalog leaked across instances. What the
   * shipped constant actually IS stays pinned independently, by canonical hash, in the next test.
   */
  const untouched = new PacsService({}, {}, { usersInGroupWithRole: async () => [] },
    { prepare: async () => {}, require: async () => {}, allowed: async () => new Set() },
    { readableFindings: async () => [] });
  assert.deepEqual([...untouched.structureCatalog], [...structure.STRUCTURE_CATALOG],
    'an untouched instance must still hold the shipped catalog, not an injected one');
});

test('the compiled product catalog is byte-for-byte the pinned canonical JSON', () => {
  /**
   * B8. The browser test pins the SAME sha for its own constant, and neither test can read the
   * other's file - this one runs inside the image against `/app/dist`. Comparing the VALUE (through
   * canonical JSON) rather than the source text means a catalog that differed only in key order or
   * whitespace would still be caught, and a real catalog cannot ship on one side alone.
   */
  const canonical = value => {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object')
      return '{' + Object.keys(value).sort()
        .map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
    return JSON.stringify(value);
  };
  const sha = crypto.createHash('sha256')
    .update(canonical([...structure.STRUCTURE_CATALOG]), 'utf8').digest('hex');
  assert.equal(sha, vectors.productCatalogSha256, 'STRUCTURE_CATALOG is not the pinned catalog');
  // Key order and indentation may differ between the TypeScript file and the browser script; the
  // canonical form is what both sides are compared as, so it may not depend on either.
  assert.equal(canonical([{ b: 1, a: [2, {}] }]), '[{"a":[2,{}],"b":1}]');
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
  /**
   * `AuditLog.detail` is `String?` (schema.prisma) and the service writes it through
   * `dump()` = JSON.stringify, so what is stored is a JSON STRING. The two halves of this
   * assertion need different views of it, and the citation test set the precedent for both:
   * parse it to check what IS recorded (:295, :529), and read the raw string to check what is
   * NOT (:522-527). Stringifying it again would hide every inner quote and make the positive
   * half vacuous.
   */
  const detail = JSON.parse(entry.detail);
  assert.equal(detail.strs.n, 1, 'one live entry is recorded');
  assert.equal(detail.strs.add.length, 1);
  assert.match(detail.strs.add[0], UUID, 'and it is named by its server-generated sid, nothing else');
  assert.deepEqual(Object.keys(detail.strs).sort(), ['add', 'n'], 'counts and sids only');
  const raw = String(entry.detail ?? '');
  assert.equal(raw.includes(CHOICE_LINE), false, 'the sentence must not reach the audit trail');
  assert.equal(raw.includes('SYN-CHOICE'), false, 'nor the item code');
  assert.equal(raw.includes('"c1"'), false, 'nor the value');
  assert.doesNotMatch(raw, /renderedText|valueType|templateId/, 'nor any of their field names');
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
  // Parsed for what IS recorded, raw for what is NOT - `detail` is a JSON string on the real row.
  const detail = JSON.parse(audit.detail);
  assert.deepEqual(detail.strs.dropped, ['s-head']);
  assert.equal(detail.strs.n, 1);
  const raw = String(audit.detail ?? '');
  assert.equal(raw.includes(NUMBER_LINE), false, 'the surviving sentence must not reach the audit');
  assert.equal(raw.includes(CHOICE_LINE), false, 'nor the dropped one');
  assert.doesNotMatch(raw, /renderedText|itemCode/, 'the dropped entry is named by sid alone');
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
