const test = require('node:test');
const assert = require('node:assert/strict');
const panels = require('../worklist-v0/hpacs-lite/reading-panel-layout.js');

test('INPUT: only bounded display dimensions and the related visibility flag are accepted', () => {
  const value = panels.defaults();
  assert.deepEqual(panels.normalize(value), value);
  assert.notEqual(panels.normalize(value), value);
  for (const invalid of [null, [], {}, { ...value, version: 2 }, { ...value, relatedHidden: 1 },
      { ...value, patient: 'synthetic' }, { ...value, reportWidth: undefined }]) {
    assert.equal(panels.normalize(invalid), null);
  }
  for (const key of ['reportWidth', 'imageHeight', 'relatedHeight', 'relatedListHeight']) {
    for (const number of [0, -1, 16385, 100.5, NaN, Infinity, '420', true, {}]) {
      assert.equal(panels.normalize({ ...value, [key]: number }), null);
    }
    for (const number of [1, 16384]) assert.equal(panels.normalize({ ...value, [key]: number })[key], number);
  }
});

test('DEFAULTS: responsive defaults keep the existing wide, medium and stacked dimensions', () => {
  const wide = panels.resolve(panels.defaults(), { width: 1680, height: 1100, workHeight: 800 });
  assert.equal(wide.narrow, false);
  assert.deepEqual(wide.effective, { reportWidth: 420, imageHeight: 660, relatedHeight: 245, relatedListHeight: 125 });
  assert.equal(panels.resolve(panels.defaults(), { width: 1100, height: 900 }).effective.reportWidth, 340);
  const small = panels.resolve(panels.defaults(), { width: 800, height: 700 });
  assert.equal(small.narrow, true); assert.equal(small.effective.imageHeight, 530);
});

test('RESTORE: smaller windows clamp rendered sizes without replacing durable larger dimensions', () => {
  const saved = { ...panels.defaults(), reportWidth: 600, imageHeight: 1000, relatedHeight: 500, relatedListHeight: 300 };
  const before = JSON.stringify(saved);
  const large = panels.resolve(saved, { width: 1800, height: 1200, workHeight: 1000 });
  const small = panels.resolve(saved, { width: 900, height: 650, workHeight: 621 });
  assert.equal(large.effective.reportWidth, 600); assert.equal(small.effective.reportWidth, 534);
  assert.equal(large.effective.relatedHeight, 500); assert.equal(small.effective.relatedHeight, 245);
  assert.equal(small.effective.relatedListHeight, 159);
  assert.equal(JSON.stringify(saved), before);
  assert.deepEqual(panels.resolve(saved, { width: 1800, height: 1200, workHeight: 1000 }), large);
});

test('ACCESS: wrapped related controls reserve visible rows and a usable prior report', () => {
  const saved = { ...panels.defaults(), relatedHeight: 1, relatedListHeight: 16384, relatedHidden: true };
  const { effective, ranges } = panels.resolve(saved, { width: 600, height: 600, workHeight: 621, listMin: 195.5 });
  assert.equal(ranges.relatedListHeight.min, 196);
  assert.equal(effective.relatedHeight, 282);
  assert.equal(effective.relatedListHeight, 196);
  assert.equal(effective.relatedHeight - effective.relatedListHeight, 86);
  assert.equal(saved.relatedHidden, true);
  for (const key of Object.keys(effective)) {
    assert.ok(effective[key] >= ranges[key].min && effective[key] <= ranges[key].max);
  }
});

test('BREAKPOINT: viewport media mode wins while element width still bounds the report panel', () => {
  const saved = { ...panels.defaults(), reportWidth: 480 };
  const wideViewport = panels.resolve(saved, { width: 820, height: 1100, narrow: false });
  assert.equal(wideViewport.narrow, false);
  assert.equal(wideViewport.effective.reportWidth, 454);
  const narrowViewport = panels.resolve(saved, { width: 870, height: 1100, narrow: true });
  assert.equal(narrowViewport.narrow, true);
  assert.equal(saved.reportWidth, 480);
  assert.equal(panels.resolve(saved, { width: 820, height: 1100 }).narrow, true);
});
