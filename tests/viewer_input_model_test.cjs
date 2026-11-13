// A1 04-5 Context Toolbar and 04-6 F.Leader: the pure parts of the shipped viewer-features-input.js.
// The screen, keys and mouse are covered by viewer_input_dom_test.py and the e2e in test_viewer_tools.py.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

function load() {
  const window = {};
  vm.runInNewContext(readFileSync('worklist-v0/hpacs-lite/viewer-features-input.js', 'utf8'), { window });
  assert.ok(window.KinViewerInputModel, 'the module publishes its pure parts');
  return window.KinViewerInputModel;
}
// Values made in the module's realm, compared as plain data.
const plain = value => JSON.parse(JSON.stringify(value));

test('A1 04-6: function keys run a–z then 1–9 in menu order; past 35 the same keys continue on Tab pages', () => {
  const model = load();
  const keys = plain(model.leaderKeys(80));
  assert.deepEqual(keys.slice(0, 3).map(k => k.key), ['a', 'b', 'c']);
  assert.deepEqual([keys[25], keys[26], keys[34]].map(k => [k.key, k.page]), [['z', 0], ['1', 0], ['9', 0]]);
  assert.deepEqual([keys[35], keys[69], keys[70], keys[79]].map(k => [k.key, k.page]), [['a', 1], ['9', 1], ['a', 2], ['j', 2]]);
  // Every function has a key: no two functions share a key on one page.
  const seen = new Set(keys.map(k => k.page + ':' + k.key));
  assert.equal(seen.size, 80);
  assert.deepEqual(plain(model.leaderKeys(0)), []);
});

test('A1 04-6: areas v n c m s; menus, module buttons and toolbar tools each in their area, MG at the end of View', () => {
  const model = load();
  assert.deepEqual(plain(model.AREAS).map(([key]) => key), ['v', 'n', 'c', 'm', 's']);
  const actions = [
    { id: 'mgMirror', menu: 'MG', label: 'Mirrored', module: 'mg' },
    { id: 'overlay', menu: 'Display', label: 'Overlay Items…', module: 'display' },
    { id: 'navBar', menu: 'Navigate', label: 'Navigation Bar', module: 'navigate' },
    { id: 'related', menu: 'Compare', label: 'Related Studies', module: 'compare' },
    { id: 'priorPrev', menu: null, label: '‹ Prior', module: 'compare', button: true },
    { id: 'ctr', menu: 'Measure', label: 'CTR', module: 'measure' },
    { id: 'spine', menu: null, label: 'Spine Label', module: 'measure-lines', shortcut: true },
    { id: 'fLeader', menu: null, label: 'F.Leader', module: 'input', button: true },
  ];
  const tools = [['WindowLevel', 'Window / Level'], ['StackScroll', 'Stack Scroll'], ['Length', 'Length'], ['invert', 'Invert'], ['Cine', 'Cine'], ['Angle', 'Angle']]
    .map(([id, label]) => ({ id, label }));
  const settings = [{ id: 'mouseWheel', label: 'Mouse & Wheel…' }, { id: 'contextToolbar', label: 'Context Toolbar…' }];
  const areas = JSON.parse(JSON.stringify(model.areas({ actions, tools, settings, exclude: ['fLeader'] })));
  const ids = area => areas[area].map(entry => entry.id);
  assert.deepEqual(ids('v'), ['overlay', 'WindowLevel', 'invert', 'mgMirror']);
  assert.deepEqual(ids('n'), ['navBar', 'StackScroll', 'Cine']);
  assert.deepEqual(ids('c'), ['related', 'priorPrev']);
  assert.deepEqual(ids('m'), ['ctr', 'spine', 'Length', 'Angle']);
  assert.deepEqual(areas.s, [{ kind: 'settings', id: 'viewerSettings', label: 'Viewer Settings' },
    { kind: 'setting', id: 'mouseWheel', label: 'Mouse & Wheel…' }, { kind: 'setting', id: 'contextToolbar', label: 'Context Toolbar…' }]);
  assert.deepEqual(areas.m[0], { kind: 'feature', id: 'ctr', label: 'CTR' });
  assert.deepEqual(areas.m[2], { kind: 'tool', id: 'Length', label: 'Length' });
  // Nothing registered: the toolbar's tools and Viewer Settings are still reached.
  const bare = plain(model.areas({ tools }));
  assert.equal(bare.c.length, 0);
  assert.deepEqual(bare.m.map(entry => entry.id), ['Length', 'Angle']);
});

test('A1 04-5: the Context Toolbar value is checked on read; off with the default tools when nothing is stored', () => {
  const model = load();
  assert.deepEqual(plain(model.contextSettings(undefined)), { on: false, items: ['WindowLevel', 'Zoom', 'Pan', 'Length', 'EllipticalROI', 'ArrowAnnotate', 'invert'] });
  assert.deepEqual(plain(model.contextSettings({ on: true, items: ['invert', 'Zoom', 'invert', 7, '<b>', 'rotate-left'] })), { on: true, items: ['invert', 'Zoom', 'rotate-left'] });
  assert.deepEqual(plain(model.contextSettings({ on: 'yes', items: [] })), { on: false, items: [] });
  assert.deepEqual(plain(model.contextSettings([1, 2])), plain(model.contextSettings(null)));
  assert.equal(model.contextSettings({ items: Array.from({ length: 90 }, (_, n) => 'tool' + n) }).items.length, 64);
  assert.equal(model.MOVE, 4); assert.equal(model.HOLD, 400);
});
