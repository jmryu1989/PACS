'use strict';
/* TEST-S3-U1-ADDENDUM-OUTPUT: pure checks for the report preview's saved label.
 * The same text is the printed header and, without the RS suffix, the identity
 * line repeated in every page's margin box. */
const assert = require('node:assert/strict');
const { test } = require('node:test');

const preview = require('../worklist-v0/hpacs-lite/report-preview.js');

// The head ReportVersion row as the report-preview response carries it.
const approved = { version: 1, rs: 'A', action: 'approve' };
const unapproved = { version: 2, rs: 'W', action: 'save' };
const addendum = { version: 3, rs: 'A', action: 'addendum' };
const ACTIONS = ['approve', 'save', 'reset', 'preliminary', 'defer', 'discarded', '', null, undefined];

test('only the pure label is exported and the browser factory still exists', () => {
  assert.deepEqual(Object.keys(preview), ['savedLabel']);
  assert.equal(typeof preview.savedLabel, 'function');
  assert.equal(typeof globalThis.KinReportPreview, 'function');
});

test('the printed header keeps the saved wording byte for byte', () => {
  assert.equal(preview.savedLabel({ version: 0, rs: 'W' }, true), '저장된 판독문 없음');
  assert.equal(preview.savedLabel(approved, true), '승인된 저장본 · v1 · RS A');
  assert.equal(preview.savedLabel(unapproved, true), '미승인 저장본 · v2 · RS W');
  // A response that predates the field, or carries any other action, reads as before.
  for (const action of ACTIONS) {
    assert.equal(preview.savedLabel({ ...approved, action }, true), '승인된 저장본 · v1 · RS A', String(action));
    assert.equal(preview.savedLabel({ ...unapproved, action }, true), '미승인 저장본 · v2 · RS W', String(action));
  }
});

test('the repeated identity line is the same wording without the RS suffix', () => {
  assert.equal(preview.savedLabel({ version: 0, rs: 'W' }, false), '저장된 판독문 없음');
  assert.equal(preview.savedLabel(approved, false), '승인된 저장본 · v1');
  assert.equal(preview.savedLabel(unapproved, false), '미승인 저장본 · v2');
  for (const report of [approved, unapproved, addendum, { version: 0, rs: 'W' }]) {
    const line = preview.savedLabel(report, false);
    assert.ok(!line.includes('RS'), line);
    assert.ok(preview.savedLabel(report, true).startsWith(line), line);
  }
});

test('an addendum is named and numbered by its own row in both lines', () => {
  assert.equal(preview.savedLabel(addendum, true), '승인된 추가기재 · v3 · RS A');
  assert.equal(preview.savedLabel(addendum, false), '승인된 추가기재 · v3');
  for (const withRs of [true, false]) {
    const text = preview.savedLabel(addendum, withRs);
    assert.ok(text.includes('추가기재'), text);
    // Its own version number and no other: the history records no parent version.
    assert.deepEqual(text.match(/v\d+/g), ['v3'], text);
    assert.ok(!text.includes('저장본') && !text.includes('미확정'), text);
  }
  // An addendum row that is not the approved state still says addendum; an empty
  // history still says so instead of naming a version that was never written.
  assert.equal(preview.savedLabel({ version: 4, rs: 'W', action: 'addendum' }, true), '미승인 추가기재 · v4 · RS W');
  assert.equal(preview.savedLabel({ version: 0, rs: 'A', action: 'addendum' }, true), '저장된 판독문 없음');
});

test('the label never says addendum for a version that was not one', () => {
  for (const version of [0, 1, 2, 7])
    for (const rs of ['A', 'W', 'T', 'P', 'H'])
      for (const action of [...ACTIONS, 'addendum'])
        for (const withRs of [true, false]) {
          const report = { version, rs, action }, text = preview.savedLabel(report, withRs);
          assert.equal(text.includes('추가기재'), !!version && action === 'addendum', JSON.stringify(report));
          assert.equal(text.includes('v' + version), !!version, JSON.stringify(report));
        }
});
