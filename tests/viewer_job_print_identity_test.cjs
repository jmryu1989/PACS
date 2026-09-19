'use strict';
/* TEST-D09-OUTPUT-IDENTITY: pure checks for the print dialog's identity helper. */
const assert = require('node:assert/strict');
const { test } = require('node:test');

const identity = require('../worklist-v0/hpacs-lite/viewer-job-print.js');

const study = (uid, date, extra) => Object.assign({ uid, id: 'PID-' + uid, name: '홍 길동', date,
  acc: 'ACC-' + uid, desc: 'CHEST CT', modality: 'CT' }, extra);
const approved = { version: 1, rs: 'A', author: 'doctor', repDoc: 'doctor', confirm: '2026-08-02T00:00:00Z',
  findings: 'F', conclusion: 'C', recommendation: 'R' };
const unapproved = { version: 2, rs: 'W', author: 'doctor', repDoc: null, confirm: null,
  findings: 'F', conclusion: 'C', recommendation: 'R' };
// S3-U1: the head version row's own action, as the report-preview response now carries it.
const addendum = { version: 3, rs: 'A', action: 'addendum', author: 'doctor2', repDoc: 'doctor2',
  confirm: '2026-08-03T00:00:00Z', findings: 'F', conclusion: 'C', recommendation: 'R' };
const CURRENT = 'uid-current', COMPARE = 'uid-compare';

function pair(comparisonDate, currentDate = '20260801') {
  const identities = [study(CURRENT, currentDate), study(COMPARE, comparisonDate)];
  return { identities, entries: [identity.reportEntry(CURRENT, approved, identities, CURRENT),
    identity.reportEntry(COMPARE, unapproved, identities, CURRENT)] };
}

test('module loads under require and still defines the browser factory', () => {
  assert.equal(typeof globalThis.kinViewerJobPrint, 'function');
  for (const name of ['normalizeStudyDate', 'dateText', 'dateRelation', 'relationText', 'reportTitle',
    'reportLabel', 'optionLabel', 'reportEntry', 'studyLine', 'dateLine', 'summaryText', 'pageIdentity',
    'pageName', 'cssContent', 'pageRules'])
    assert.equal(typeof identity[name], 'function', name);
});

test('normalizeStudyDate accepts only real calendar dates', () => {
  assert.equal(identity.normalizeStudyDate('20260801'), '20260801');
  assert.equal(identity.normalizeStudyDate('2026-07-01'), '20260701');
  assert.equal(identity.normalizeStudyDate('20240229'), '20240229');
  assert.equal(identity.normalizeStudyDate('20000229'), '20000229');
  for (const bad of ['20230229', '19000229', '20261345', '20260000', '20260832', '20261301', '',
    '   ', '2026080', '202608011', 'ABCDEFGH', 'BADDATE1', '2026/08/01', '2026-8-1', ' 20260801'])
    assert.equal(identity.normalizeStudyDate(bad), null, JSON.stringify(bad));
  for (const bad of [undefined, null, 20260801, {}, [], new Date()])
    assert.equal(identity.normalizeStudyDate(bad), null, String(bad));
});

test('dateText keeps the stored original and names a missing date', () => {
  assert.equal(identity.dateText({ date: '20260801' }), '20260801');
  assert.equal(identity.dateText({ date: '2026-08-01' }), '2026-08-01');
  assert.equal(identity.dateText({ date: 'BADDATE1' }), 'BADDATE1');
  assert.equal(identity.dateText({ date: '' }), '날짜 없음');
  assert.equal(identity.dateText({ date: '   ' }), '날짜 없음');
  assert.equal(identity.dateText({}), '날짜 없음');
  assert.equal(identity.dateText(null), '날짜 없음');
});

test('dateRelation separates earlier, later, same and unknown', () => {
  assert.equal(identity.dateRelation('20260801', '20260701'), 'earlier');
  assert.equal(identity.dateRelation('20260801', '20260901'), 'later');
  assert.equal(identity.dateRelation('20260801', '20260801'), 'same');
  assert.equal(identity.dateRelation('20260801', '2026-08-01'), 'same');
  assert.equal(identity.dateRelation('20260801', ''), 'unknown');
  assert.equal(identity.dateRelation('20260801', 'BADDATE1'), 'unknown');
  assert.equal(identity.dateRelation('BADDATE1', '20260901'), 'unknown');
  assert.equal(identity.dateRelation('', ''), 'unknown');
});

test('relationText states the relation instead of a position', () => {
  assert.equal(identity.relationText('earlier'), '현재 검사보다 이전');
  assert.equal(identity.relationText('later'), '현재 검사보다 이후');
  assert.equal(identity.relationText('same'), '현재 검사와 같은 날짜 · 선후 미확인');
  assert.equal(identity.relationText('unknown'), '검사일 확인 불가 · 선후 미확인');
  assert.equal(identity.relationText('nonsense'), '검사일 확인 불가 · 선후 미확인');
  for (const relation of ['earlier', 'later', 'same', 'unknown'])
    assert.ok(!identity.relationText(relation).includes('과거'), relation);
});

test('reportTitle and reportLabel keep the strings other tests depend on', () => {
  assert.equal(identity.reportTitle('current'), 'Current Study Report');
  assert.equal(identity.reportTitle('comparison'), 'Comparison Study Report');
  assert.equal(identity.reportLabel({ version: 0, rs: 'W' }), '저장된 판독문 없음');
  assert.equal(identity.reportLabel(approved), '승인된 저장본 · v1 · RS A');
  assert.equal(identity.reportLabel(unapproved), '미승인 저장본 · v2 · RS W');
  assert.equal(identity.reportLabel(addendum), '승인된 추가기재 · v3 · RS A');
});

test('optionLabel describes the comparison by its own date', () => {
  const comparison = study(COMPARE, '20260901');
  assert.equal(identity.optionLabel('none'), 'Images only');
  assert.equal(identity.optionLabel('saved'), 'Current study report');
  assert.equal(identity.optionLabel('both', comparison), 'Current + comparison study reports');
  assert.equal(identity.optionLabel('prior', comparison),
    'Comparison study report (20260901 · CHEST CT · Acc ACC-uid-compare)');
  assert.equal(identity.optionLabel('prior', study(COMPARE, '', { desc: '', acc: '' })),
    'Comparison study report (날짜 없음 · CT · Acc -)');
  assert.equal(identity.optionLabel('prior', study(COMPARE, 'BADDATE1')),
    'Comparison study report (BADDATE1 · CHEST CT · Acc ACC-uid-compare)');
  for (const date of ['20260901', '20260801', '20260701', '', 'BADDATE1'])
    assert.ok(!identity.optionLabel('prior', study(COMPARE, date)).includes('과거'), date);
});

test('reportEntry resolves the role and the relation, never the array position', () => {
  const { entries } = pair('20260901');
  assert.equal(entries[0].role, 'current');
  assert.equal(entries[0].title, 'Current Study Report');
  assert.equal(entries[0].relation, null);
  assert.equal(entries[0].relationText, null);
  assert.equal(entries[0].identity.uid, CURRENT);
  assert.equal(entries[1].role, 'comparison');
  assert.equal(entries[1].title, 'Comparison Study Report');
  assert.equal(entries[1].relation, 'later');
  assert.equal(entries[1].relationText, '현재 검사보다 이후');
  assert.equal(entries[1].report, unapproved);
  // The dialog compares two state() reads with JSON.stringify.
  assert.deepEqual(JSON.parse(JSON.stringify(entries)), JSON.parse(JSON.stringify(pair('20260901').entries)));
  const reversed = pair('20260701');
  assert.equal(reversed.entries[1].relation, 'earlier');
  assert.equal(identity.reportEntry(COMPARE, unapproved, pair('20260801').identities, CURRENT).relation, 'same');
  assert.equal(identity.reportEntry(COMPARE, unapproved, pair('').identities, CURRENT).relation, 'unknown');
  assert.equal(identity.reportEntry(COMPARE, unapproved, pair('20260901', 'BADDATE1').identities, CURRENT).relation, 'unknown');
});

test('studyLine and dateLine identify the study without its date order', () => {
  const { entries } = pair('20260901');
  assert.equal(identity.studyLine(entries[1].identity), '홍 길동 (PID-uid-compare) · CHEST CT · Acc ACC-uid-compare');
  assert.equal(identity.studyLine(study(COMPARE, '20260901', { desc: '', acc: '' })), '홍 길동 (PID-uid-compare) · CT · Acc -');
  assert.equal(identity.dateLine(entries[0]), '검사일 20260801 · 현재 검사');
  assert.equal(identity.dateLine(entries[1]), '검사일 20260901 · 현재 검사보다 이후');
  assert.equal(identity.dateLine(pair('20260701').entries[1]), '검사일 20260701 · 현재 검사보다 이전');
  assert.equal(identity.dateLine(pair('20260801').entries[1]), '검사일 20260801 · 현재 검사와 같은 날짜 · 선후 미확인');
  assert.equal(identity.dateLine(pair('').entries[1]), '검사일 날짜 없음 · 검사일 확인 불가 · 선후 미확인');
  assert.equal(identity.dateLine(pair('BADDATE1').entries[1]), '검사일 BADDATE1 · 검사일 확인 불가 · 선후 미확인');
  for (const date of ['20260901', '20260801', '20260701', '', 'BADDATE1'])
    for (const entry of pair(date).entries) assert.ok(!identity.dateLine(entry).includes('과거'), date);
});

test('summaryText lists patient identity and both reports by date relation', () => {
  const { identities, entries } = pair('20260901');
  assert.equal(identity.summaryText(identities, entries), [
    '환자 홍 길동 (PID-uid-current) · 검사 20260801 · Acc ACC-uid-current',
    '환자 홍 길동 (PID-uid-compare) · 검사 20260901 · Acc ACC-uid-compare',
    'Current Study Report: 20260801 · 승인된 저장본 · v1 · RS A',
    'Comparison Study Report: 20260901 · 현재 검사보다 이후 · 미승인 저장본 · v2 · RS W',
  ].join('\n'));
  const empty = pair('');
  const text = identity.summaryText(empty.identities, empty.entries);
  assert.ok(text.includes('환자 홍 길동 (PID-uid-compare) · 검사 날짜 없음 · Acc ACC-uid-compare'), text);
  assert.ok(text.includes('Comparison Study Report: 날짜 없음 · 검사일 확인 불가 · 선후 미확인 · 미승인 저장본 · v2 · RS W'), text);
  assert.equal(identity.summaryText(identities, []),
    '환자 홍 길동 (PID-uid-current) · 검사 20260801 · Acc ACC-uid-current\n환자 홍 길동 (PID-uid-compare) · 검사 20260901 · Acc ACC-uid-compare');
  for (const date of ['20260901', '20260801', '20260701', '', 'BADDATE1']) {
    const set = pair(date);
    const summary = identity.summaryText(set.identities, set.entries);
    assert.ok(!summary.includes('과거'), date);
    assert.ok(summary.includes('(PID-uid-current)') && summary.includes('(PID-uid-compare)'), date);
  }
});

test('pageIdentity carries the whole study identity of that page alone', () => {
  const { entries } = pair('20260901');
  assert.equal(identity.pageIdentity(entries[0]), [
    'Current Study Report · 20260801',
    '홍 길동 (PID-uid-current) · CHEST CT · Acc ACC-uid-current',
    'Study uid-current',
    '승인된 저장본 · v1 · RS A',
  ].join('\n'));
  assert.equal(identity.pageIdentity(entries[1]), [
    'Comparison Study Report · 20260901 · 현재 검사보다 이후',
    '홍 길동 (PID-uid-compare) · CHEST CT · Acc ACC-uid-compare',
    'Study uid-compare',
    '미승인 저장본 · v2 · RS W',
  ].join('\n'));
  const long = '1.2.826.0.1.3680043.8.498.' + '7'.repeat(38);
  const identities = [study(CURRENT, '20260801'), study(long, 'BADDATE1')];
  const entry = identity.reportEntry(long, unapproved, identities, CURRENT);
  const footer = identity.pageIdentity(entry);
  assert.ok(footer.includes('Study ' + long), footer);
  assert.ok(footer.includes('BADDATE1') && footer.includes('검사일 확인 불가 · 선후 미확인'), footer);
  assert.ok(footer.includes('(PID-' + long + ')'), footer);
  assert.equal(footer.split('\n').length, 4);
  for (const date of ['20260901', '20260801', '20260701', '', 'BADDATE1'])
    for (const row of pair(date).entries) {
      const text = identity.pageIdentity(row);
      assert.ok(!text.includes('과거'), date);
      assert.ok(text.includes(identity.reportLabel(row.report)), date);
      assert.ok(text.includes('Study ' + row.uid), date);
      assert.ok(text.includes(identity.dateText(row.identity)), date);
    }
});

test('pageName numbers the reports in output order', () => {
  assert.equal(identity.pageName(0), 'report-0');
  assert.equal(identity.pageName(1), 'report-1');
  assert.equal(identity.pageName(12), 'report-12');
});

test('cssContent escapes quotes, newlines and non-BMP characters', () => {
  assert.equal(identity.cssContent('a'), '"\\61 "');
  assert.equal(identity.cssContent('"'), '"\\22 "');
  assert.equal(identity.cssContent('\n'), '"\\a "');
  assert.equal(identity.cssContent('a"\nb'), '"\\61 \\22 \\a \\62 "');
  assert.equal(identity.cssContent('\\'), '"\\5c "');
  assert.equal(identity.cssContent('·'), '"\\b7 "');
  assert.equal(identity.cssContent('가'), '"\\ac00 "');
  // Astral characters must escape as one code point, not two surrogates.
  assert.equal(identity.cssContent('\u{1f600}'), '"\\1f600 "');
  assert.equal(identity.cssContent('\u{10437}'), '"\\10437 "');
  assert.equal(identity.cssContent(''), '""');
  for (const char of ['"', '\n', '<', '>', '{', '}', ';', '\u{1f600}']) {
    const escaped = identity.cssContent('x' + char + 'y');
    assert.ok(escaped.startsWith('"') && escaped.endsWith('"'), escaped);
    assert.ok(!escaped.slice(1, -1).includes(char), JSON.stringify(char));
  }
});

test('pageRules binds one named page footer per report', () => {
  const { identities, entries } = pair('20260901');
  const rules = identity.pageRules(entries, identity.summaryText(identities, entries));
  assert.ok(rules.startsWith('@page{size:A4;margin:12mm 12mm 24mm;@bottom-left{content:'), rules.slice(0, 80));
  assert.ok(rules.includes('@bottom-right{content:counter(page) " / " counter(pages);font:9px sans-serif}'));
  for (const [index, entry] of entries.entries()) {
    const name = identity.pageName(index);
    assert.ok(rules.includes(`@page ${name}{@bottom-left{content:${identity.cssContent(identity.pageIdentity(entry))};font:8px "Malgun Gothic",sans-serif;white-space:pre-wrap;overflow-wrap:anywhere}}`), name);
    assert.ok(rules.includes(`.report[data-print-page="${name}"]{page:${name}}`), name);
  }
  assert.equal(rules.match(/@page report-\d+\{/g).length, 2);
  assert.notEqual(rules.indexOf('@page report-0{'), rules.indexOf('@page report-1{'));
  assert.ok(rules.endsWith('.intro{page:report-0}'), rules.slice(-40));
  assert.ok(!rules.includes('과거'));
  const single = identity.pageRules([entries[0]], 'summary');
  assert.equal(single.match(/@page report-\d+\{/g).length, 1);
  assert.ok(single.includes('.report[data-print-page="report-0"]{page:report-0}'));
  const none = identity.pageRules([], 'summary');
  assert.equal(none.match(/@page report-\d+\{/g), null);
  assert.ok(!none.includes('data-print-page') && !none.includes('.intro{'));
  assert.ok(none.startsWith('@page{size:A4;') && none.endsWith('}'));
});

/* TEST-D09-EDITOR-COMPARE-OUTPUT additions: the unsaved editor body never
 * borrows the saved report's version, approval or page wording. */
const draft = { version: null, rs: null, unsaved: true, author: 'doctor',
  findings: 'DF', conclusion: 'DC', recommendation: 'DR' };

test('reportLabel marks an unsaved editor body instead of a stored version', () => {
  assert.equal(identity.reportLabel(draft), '미확정 편집문 · 저장·승인되지 않음');
  // The wording must not be reachable from any saved report shape.
  for (const report of [approved, unapproved, addendum, { version: 0, rs: 'W' }])
    assert.ok(!identity.reportLabel(report).includes('미확정'), JSON.stringify(report));
  for (const label of ['v', 'RS', '저장본'])
    assert.ok(!identity.reportLabel(draft).includes(label), label);
  // A stale unsaved flag next to a version still refuses the saved wording.
  assert.equal(identity.reportLabel({ version: 3, rs: 'A', unsaved: true }), '미확정 편집문 · 저장·승인되지 않음');
  assert.ok(!identity.reportLabel(draft).includes('과거'));
});

test('optionLabel names the unsaved draft choices without renaming the saved ones', () => {
  const comparison = study(COMPARE, '20260901');
  assert.equal(identity.optionLabel('editor'), 'Current study draft (unsaved)');
  assert.equal(identity.optionLabel('editor-prior', comparison),
    'Current study draft (unsaved) + comparison study report (20260901 · CHEST CT · Acc ACC-uid-compare)');
  assert.equal(identity.optionLabel('editor-prior', study(COMPARE, '', { desc: '', acc: '' })),
    'Current study draft (unsaved) + comparison study report (날짜 없음 · CT · Acc -)');
  // The first pull request's four choices keep their exact wording.
  assert.equal(identity.optionLabel('none'), 'Images only');
  assert.equal(identity.optionLabel('saved'), 'Current study report');
  assert.equal(identity.optionLabel('both', comparison), 'Current + comparison study reports');
  assert.equal(identity.optionLabel('prior', comparison),
    'Comparison study report (20260901 · CHEST CT · Acc ACC-uid-compare)');
  for (const date of ['20260901', '20260801', '20260701', '', 'BADDATE1'])
    assert.ok(!identity.optionLabel('editor-prior', study(COMPARE, date)).includes('과거'), date);
});

test('a draft entry keeps the current role and carries the unsaved footer', () => {
  const identities = [study(CURRENT, '20260801'), study(COMPARE, '20260901')];
  const entry = identity.reportEntry(CURRENT, draft, identities, CURRENT);
  assert.equal(entry.role, 'current');
  assert.equal(entry.title, 'Current Study Report');
  assert.equal(entry.relation, null);
  assert.equal(identity.dateLine(entry), '검사일 20260801 · 현재 검사');
  assert.equal(identity.pageIdentity(entry), [
    'Current Study Report · 20260801',
    '홍 길동 (PID-uid-current) · CHEST CT · Acc ACC-uid-current',
    'Study uid-current',
    '미확정 편집문 · 저장·승인되지 않음',
  ].join('\n'));
  const compare = identity.reportEntry(COMPARE, unapproved, identities, CURRENT);
  const summary = identity.summaryText(identities, [entry, compare]);
  assert.ok(summary.includes('Current Study Report: 20260801 · 미확정 편집문 · 저장·승인되지 않음'), summary);
  assert.ok(summary.includes('Comparison Study Report: 20260901 · 현재 검사보다 이후 · 미승인 저장본 · v2 · RS W'), summary);
  assert.ok(!summary.includes('과거'));
  // The draft page owns its own named page, exactly like a saved report page.
  const rules = identity.pageRules([entry, compare], summary);
  assert.ok(rules.includes(`@page report-0{@bottom-left{content:${identity.cssContent(identity.pageIdentity(entry))};`), rules.slice(0, 120));
  assert.equal(rules.match(/@page report-\d+\{/g).length, 2);
  assert.ok(rules.endsWith('.intro{page:report-0}'));
});

/* S3-U1 (R12): the output names an Addendum by its own name and its own version
 * number. ReportVersion has no parent-version column and a discarded row can sit
 * at a lower number, so any lineage number on a page would be invented. */

test('reportLabel names an addendum by its own version and leaves every other action alone', () => {
  assert.equal(identity.reportLabel(addendum), '승인된 추가기재 · v3 · RS A');
  // Exactly one version number appears, and it is this row's own.
  assert.deepEqual(identity.reportLabel(addendum).match(/v\d+/g), ['v3']);
  assert.ok(!identity.reportLabel(addendum).includes('저장본'));
  // Every other stored action keeps the saved wording byte for byte, including
  // a response that predates the field.
  for (const action of ['approve', 'save', 'reset', 'preliminary', 'defer', 'discarded', '', null, undefined])
    assert.equal(identity.reportLabel({ ...approved, action }), '승인된 저장본 · v1 · RS A', String(action));
  for (const action of ['approve', 'save', 'defer', null, undefined])
    assert.equal(identity.reportLabel({ ...unapproved, action }), '미승인 저장본 · v2 · RS W', String(action));
  // An addendum row that is not the approved state still says addendum, and the
  // version and unsaved rules keep winning over the action.
  assert.equal(identity.reportLabel({ version: 4, rs: 'W', action: 'addendum' }), '미승인 추가기재 · v4 · RS W');
  assert.equal(identity.reportLabel({ version: 0, rs: 'A', action: 'addendum' }), '저장된 판독문 없음');
  assert.equal(identity.reportLabel({ ...addendum, unsaved: true }), '미확정 편집문 · 저장·승인되지 않음');
});

test('the repeated page identity and the summary say addendum for that study alone', () => {
  const identities = [study(CURRENT, '20260801'), study(COMPARE, '20260901')];
  const head = identity.reportEntry(CURRENT, addendum, identities, CURRENT);
  const compare = identity.reportEntry(COMPARE, unapproved, identities, CURRENT);
  assert.equal(identity.pageIdentity(head), [
    'Current Study Report · 20260801',
    '홍 길동 (PID-uid-current) · CHEST CT · Acc ACC-uid-current',
    'Study uid-current',
    '승인된 추가기재 · v3 · RS A',
  ].join('\n'));
  const summary = identity.summaryText(identities, [head, compare]);
  assert.ok(summary.includes('Current Study Report: 20260801 · 승인된 추가기재 · v3 · RS A'), summary);
  // The comparison study keeps its own label: one addendum does not rename the other page.
  assert.ok(summary.includes('Comparison Study Report: 20260901 · 현재 검사보다 이후 · 미승인 저장본 · v2 · RS W'), summary);
  assert.equal(summary.match(/추가기재/g).length, 1);
  const rules = identity.pageRules([head, compare], summary);
  assert.ok(rules.includes(`@page report-0{@bottom-left{content:${identity.cssContent(identity.pageIdentity(head))};`), rules.slice(0, 160));
  assert.ok(rules.includes(identity.cssContent(identity.pageIdentity(compare))));
});

/* The reading window's preview header prints the same stored report from the same
 * response. The two output surfaces must not name the same row differently. */
const reportPreview = require('../worklist-v0/hpacs-lite/report-preview.js');

test('the reading window preview and this dialog agree on every saved label', () => {
  assert.equal(typeof reportPreview.savedLabel, 'function');
  for (const version of [0, 1, 3])
    for (const rs of ['A', 'W', 'T', 'P', 'H'])
      for (const action of ['approve', 'addendum', 'save', 'reset', 'preliminary', 'defer', 'discarded', null, undefined]) {
        const report = { version, rs, action }, label = identity.reportLabel(report), where = JSON.stringify(report);
        assert.equal(reportPreview.savedLabel(report, true), label, where);
        // The preview's repeated identity line is the same text without RS.
        assert.equal(reportPreview.savedLabel(report, false), version ? label.replace(` · RS ${rs}`, '') : label, where);
        assert.equal(label.includes('추가기재'), !!version && action === 'addendum', where);
      }
});

/* A11-OUTPUT transport fix (hosted diagnostic run 35022850312): the one source read of every saved-image output. Chromium failed a
 * read bound to an HTTP/2 connection whose GOAWAY arrived before the read's stream existed, with ERR_FAILED and no resend of its
 * own, so fetch() rejected it with a TypeError before any response. */
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const SOURCE_READ_FAILED = '출력 원본을 읽지 못했습니다. 다시 확인하세요.';
const transportRejection = () => Promise.reject(new TypeError('Failed to fetch'));
const aborted = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
function reply(chunks, { ok = true, body = true, failAt = -1, failure = () => new TypeError('network error'), cancelled = [] } = {}) {
  let index = 0;
  return { ok, status: ok ? 200 : 503, body: body ? { getReader: () => ({
    read: async () => { if (index === failAt) { index++; throw failure(); } return index < chunks.length ? { done: false, value: chunks[index++] } : { done: true }; },
    cancel: async () => { cancelled.push(true); } }) } : null };
}
async function withFetch(route, work) {
  const real = globalThis.fetch, calls = [];
  globalThis.fetch = (url, init) => { calls.push({ url, init }); return route(url, init, calls.filter(call => call.url === url).length); };
  // A loader whose other worker is still reading settles against this stub before the real fetch returns.
  try { return await work(calls); } finally { await new Promise(resolve => setTimeout(resolve, 20)); globalThis.fetch = real; }
}

test('a source read that fetch() rejects before any response is sent once more on the same signal', async () => {
  const signal = new AbortController().signal, budget = { bytes: 0 };
  await withFetch((url, init, n) => n === 1 ? transportRejection() : reply([Uint8Array.of(1, 2), Uint8Array.of(3)]), async calls => {
    assert.deepEqual([...await identity.sourceBytes('/instances/a/simplified-tags', signal, 16, budget)], [1, 2, 3]);
    assert.deepEqual(calls.map(call => call.url), ['/instances/a/simplified-tags', '/instances/a/simplified-tags']);
    for (const { init } of calls)
      assert.deepEqual([init.signal === signal, init.cache, init.credentials, init.headers.Accept], [true, 'no-store', 'same-origin', 'application/json']);
    assert.equal(budget.bytes, 3);
  });
});

test('a source read rejected on both sends reads as the source-read failure after exactly two sends', async () => {
  await withFetch(() => transportRejection(), async calls => {
    await assert.rejects(identity.sourceBytes('/instances/a/frames/0/image-uint16', new AbortController().signal, 16, { bytes: 0 }, 'image/x-portable-arbitrarymap'),
      error => error.name === 'Error' && error.message === SOURCE_READ_FAILED);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].init.headers.Accept, 'image/x-portable-arbitrarymap');
  });
});

test('an abort (close, re-check or the output timer) is never sent again and keeps its own error for bounded()', async () => {
  const before = new AbortController(); before.abort();
  await withFetch((url, init) => Promise.reject(init.signal.aborted ? aborted() : new TypeError('Failed to fetch')), async calls => {
    await assert.rejects(identity.sourceBytes('/a', before.signal, 16, { bytes: 0 }), { name: 'AbortError' });
    assert.equal(calls.length, 1);
  });
  const timer = new AbortController(), expired = aborted();
  await withFetch((url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(expired), { once: true })), async calls => {
    const read = identity.sourceBytes('/a', timer.signal, 16, { bytes: 0 }); setTimeout(() => timer.abort(), 5);
    await assert.rejects(read, thrown => thrown === expired);
    assert.equal(calls.length, 1);
  });
  // A rejection that arrives after the signal was aborted is not sent again either.
  const late = new AbortController();
  await withFetch(() => { late.abort(); return transportRejection(); }, async calls => {
    await assert.rejects(identity.sourceBytes('/a', late.signal, 16, { bytes: 0 }), { name: 'TypeError', message: 'Failed to fetch' });
    assert.equal(calls.length, 1);
  });
});

test('an HTTP error response or a response without a body is not sent again and keeps the source-read message', async () => {
  for (const answer of [reply([], { ok: false }), reply([], { body: false })])
    await withFetch(() => answer, async calls => {
      await assert.rejects(identity.sourceBytes('/a', new AbortController().signal, 16, { bytes: 0 }), { message: SOURCE_READ_FAILED });
      assert.equal(calls.length, 1);
    });
});

test('a failed body read is not sent again: it reads as the source-read failure, cancels the reader, and an aborted read keeps its abort', async () => {
  const cancelled = [];
  await withFetch(() => reply([Uint8Array.of(1), Uint8Array.of(2)], { failAt: 1, cancelled }), async calls => {
    await assert.rejects(identity.sourceBytes('/a', new AbortController().signal, 16, { bytes: 0 }), { message: SOURCE_READ_FAILED });
    assert.deepEqual([calls.length, cancelled.length], [1, 1]);
  });
  const controller = new AbortController(), error = aborted();
  await withFetch(() => reply([Uint8Array.of(1)], { failAt: 0, failure: () => { controller.abort(); return error; } }), async calls => {
    await assert.rejects(identity.sourceBytes('/a', controller.signal, 16, { bytes: 0 }), thrown => thrown === error);
    assert.equal(calls.length, 1);
  });
});

test('the size and shared budget limits keep their own message and are not sent again', async () => {
  await withFetch(() => reply([new Uint8Array(17)]), async calls => {
    await assert.rejects(identity.sourceBytes('/a', new AbortController().signal, 16, { bytes: 0 }), { message: '출력 원본 용량 한도를 초과했습니다.' });
    assert.equal(calls.length, 1);
  });
  await withFetch(() => reply([new Uint8Array(4)]), async calls => {
    await assert.rejects(identity.sourceBytes('/a', new AbortController().signal, 16, { bytes: 67108862 }), { message: '출력 원본 용량 한도를 초과했습니다.' });
    assert.equal(calls.length, 1);
  });
});

// The real version 4-6, 12 and 13 volume loader, reading through the shared source read. Its digest check needs every source, so a
// digest refusal proves every read, the once-rejected one included, completed; the lookup it sends is declared read-only.
const HPACS = path.join(__dirname, '../worklist-v0/hpacs-lite');
const STUDY_UID = '1.2.840.1.1', SERIES_UID = '1.2.840.1.2', SOPS = ['1.2.840.1.5', '1.2.840.1.6'];
const instanceId = index => 'aaaaaaaa-bbbbbbbb-cccccccc-dddddddd-' + String(index).padStart(8, '0');
function loaderWorld(version) {
  const sandbox = { crypto: globalThis.crypto, TextDecoder, TextEncoder, cornerstone: {}, kinRenderVolumeMipPrint: async () => ({}),
    KinVolumeBatch: { plan() {} }, KinVolumeBatchScout: { camera() {}, line() {} }, kinRenderVolumeScout: async () => ({}) };
  sandbox.window = sandbox;
  vm.runInContext(fs.readFileSync(path.join(HPACS, 'viewer-volume-job-print.js'), 'utf8'), vm.createContext(sandbox), { filename: 'viewer-volume-job-print.js' });
  const cell = { projection: { blend: 1 } };
  const snapshot = { version, volume: { study: STUDY_UID, series: SERIES_UID, sops: SOPS, sourceDigest: 'f'.repeat(64) },
    ...(version === 5 ? { batch: { cell } } : { cells: [cell] }) };
  return { load: (api, signal) => sandbox.kinRenderVolumeJobPrint({ snapshot, api, bytes: identity.sourceBytes, signal, check() {} }) };
}
function source(url) {
  const [, index, kind] = /^\/instances\/aaaaaaaa-bbbbbbbb-cccccccc-dddddddd-(\d{8})\/(attachments\/dicom\/info|simplified-tags|frames\/0\/image-uint16)$/.exec(url);
  const json = value => reply([new TextEncoder().encode(JSON.stringify(value))]);
  if (kind === 'attachments/dicom/info') return json({ UncompressedMD5: String(Number(index)).repeat(32) });
  if (kind === 'simplified-tags') return json({ StudyInstanceUID: STUDY_UID, SeriesInstanceUID: SERIES_UID, SOPInstanceUID: SOPS[Number(index)],
    SOPClassUID: '1.2.840.10008.5.1.4.1.1.2', Modality: 'CT', NumberOfFrames: 1, SamplesPerPixel: 1, PhotometricInterpretation: 'MONOCHROME2',
    Rows: 2, Columns: 2, BitsAllocated: 16, BitsStored: 12, HighBit: 11, PixelRepresentation: 0 });
  const header = new TextEncoder().encode('P7\nWIDTH 2\nHEIGHT 2\nDEPTH 1\nMAXVAL 65535\nTUPLTYPE GRAYSCALE\nENDHDR\n'), frame = new Uint8Array(header.length + 8);
  frame.set(header);
  return reply([frame]);
}

test('the version 4-6 and 12-15 volume loader reads past one rejected source read, fails on two, and never sends an abort again', async () => {
  const target = '/instances/' + instanceId(1) + '/simplified-tags';
  // A11-ORIENT-1: versions 14/15 are the anatomical-preset MIP pair and share this loader, so the bounded transport recovery
  // (D12 addendum) is proven for them too.
  for (const version of [4, 5, 6, 12, 13, 14, 15]) {
    const world = loaderWorld(version), lookups = [];
    const api = async (url, options) => { lookups.push([url, options.method, options.idempotent]); return { id: instanceId(SOPS.indexOf(JSON.parse(options.body).sopUid)) }; };
    await withFetch((url, init, n) => url === target && n === 1 ? transportRejection() : source(url), async calls => {
      await assert.rejects(world.load(api, new AbortController().signal), { message: '저장 당시 전체 원본과 달라 출력하지 않았습니다.' }, 'version ' + version);
      assert.equal(calls.filter(call => call.url === target).length, 2, 'version ' + version + ': the rejected read was sent once more');
      assert.equal(calls.filter(call => call.url.endsWith('/frames/0/image-uint16')).length, 2, 'version ' + version + ': every frame was read');
      assert.deepEqual(lookups, [['/dicom/lookup', 'POST', true], ['/dicom/lookup', 'POST', true]], 'version ' + version);
    });
    await withFetch(url => url === target ? transportRejection() : source(url), async calls => {
      await assert.rejects(world.load(api, new AbortController().signal), { message: SOURCE_READ_FAILED }, 'version ' + version);
      assert.equal(calls.filter(call => call.url === target).length, 2, 'version ' + version + ': exactly two sends');
    });
    const controller = new AbortController();
    await withFetch(url => { if (url !== target) return source(url); controller.abort(); return Promise.reject(aborted()); }, async calls => {
      await assert.rejects(world.load(api, controller.signal), { name: 'AbortError' }, 'version ' + version);
      assert.equal(calls.filter(call => call.url === target).length, 1, 'version ' + version + ': an abort is not sent again');
    });
  }
});
