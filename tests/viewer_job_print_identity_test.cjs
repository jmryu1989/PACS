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
  for (const report of [approved, unapproved, { version: 0, rs: 'W' }])
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
