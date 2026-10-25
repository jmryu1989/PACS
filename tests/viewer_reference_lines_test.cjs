// REQ-MG-03 -> RISK-MG-FALSE-ANATOMY -> TEST-MG-REFERENCE-LINES.
// Exercise the shipped extension's tool lifecycle/render boundary. Native geometry
// and SVG removal are checked separately on the served viewer with public samples.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');

function fixture(before = false) {
  const images = new Map(), viewports = new Map(), groups = new Map(), subscribers = new Set();
  const draws = [];
  const native = function (element, svg) { draws.push({ tool: this, element, svg }); return 'native result'; };
  function group(id) {
    const tools = new Map();
    const value = { addTool(name) { tools.set(name, { editData: { sourceViewportId: 'source' }, renderAnnotation: native }); },
      hasTool: name => tools.has(name), getToolInstance: name => tools.get(name) };
    groups.set(id, value);
    subscribers.forEach(fn => fn({ toolGroupId: id }));
    return value;
  }
  const manager = { getAllToolGroups: () => [...groups.values()], getToolGroup: id => groups.get(id) };
  const window = { cornerstoneTools: { ToolGroupManager: manager }, cornerstone: {
    metaData: { get: (_, id) => images.get(id) },
    getEnabledElementByViewportId: id => viewports.has(id) ? { viewport: viewports.get(id) } : undefined,
  } };
  if (before) group('before').addTool('ReferenceLines');
  vm.runInNewContext(readFileSync(require.resolve('../config/ohif.js'), 'utf8'), { window, document: {} });
  const extension = window.config.extensions.find(e => e.id === 'kin.mg-reference-lines');
  extension.preRegistration({ servicesManager: { services: { toolGroupService: {
    EVENTS: { TOOLGROUP_CREATED: 'created' }, subscribe(_, fn) { subscribers.add(fn); return { unsubscribe() { subscribers.delete(fn); } }; },
  } } } });
  extension.onModeEnter();
  const current = before ? groups.get('before') : group('after');
  if (!before) current.addTool('ReferenceLines');
  const tool = current.getToolInstance('ReferenceLines');
  const image = overrides => ({ Modality: 'MG', StudyInstanceUID: 'study', FrameOfReferenceUID: 'frame', ImageLaterality: 'R', ...overrides });
  function pane(id, value) {
    images.set(id, value);
    const viewport = { getCurrentImageId: () => id };
    viewports.set(id, viewport); return { viewport };
  }
  pane('source', image());
  const target = pane('target', image()), svg = {};
  return { extension, tool, native, image, images, pane, groups, subscribers, draws,
    render: () => tool.renderAnnotation(target, svg), target, svg };
}

test('MG matched patient coordinates reach the native renderer, before and after group creation', () => {
  for (const before of [true, false]) {
    const f = fixture(before);
    assert.equal(f.render(), 'native result');
    assert.equal(f.draws.length, 1);
    assert.equal(f.draws[0].tool, f.tool);
    assert.equal(f.draws[0].element, f.target);
    assert.equal(f.draws[0].svg, f.svg);
  }
});

test('MG mismatched or absent coordinate identity never reaches native drawing', () => {
  const f = fixture();
  for (const override of [{ FrameOfReferenceUID: 'other-view' }, { FrameOfReferenceUID: '' },
    { FrameOfReferenceUID: undefined }, { StudyInstanceUID: 'prior' }, { StudyInstanceUID: undefined },
    { ImageLaterality: 'L' }, { ImageLaterality: undefined }, { Laterality: 'L' }, { Modality: 'CT' }]) {
    f.images.set('target', f.image(override));
    assert.equal(f.render(), false, JSON.stringify(override));
  }
  f.images.delete('target'); assert.equal(f.render(), false);
  f.images.set('target', f.image()); f.images.delete('source'); assert.equal(f.render(), false);
  assert.equal(f.draws.length, 0);
});

test('fresh source and target identities are checked on every render, including A to B to A', () => {
  const f = fixture();
  assert.equal(f.render(), 'native result');
  f.pane('prior', f.image({ StudyInstanceUID: 'prior' }));
  f.tool.editData.sourceViewportId = 'prior'; assert.equal(f.render(), false);
  f.tool.editData.sourceViewportId = 'source'; assert.equal(f.render(), 'native result');
  f.images.set('source', f.image({ FrameOfReferenceUID: 'replacement' })); assert.equal(f.render(), false);
  f.images.set('target', f.image({ FrameOfReferenceUID: 'replacement' })); assert.equal(f.render(), 'native result');
});

test('enhanced frame laterality is accepted only when the supplied sides agree', () => {
  const f = fixture();
  for (const value of [
    { Laterality: 'R' }, { FrameAnatomySequence: { FrameLaterality: 'R' } },
    { SharedFunctionalGroupsSequence: [{ FrameAnatomySequence: [{ FrameLaterality: 'R' }] }] },
    { PerFrameFunctionalGroupsSequence: [{ FrameAnatomySequence: { FrameLaterality: 'R' } }] },
  ]) {
    f.images.set('target', f.image({ ImageLaterality: undefined, ...value }));
    assert.equal(f.render(), 'native result');
  }
  f.images.set('target', f.image({ PerFrameFunctionalGroupsSequence: [{ FrameAnatomySequence: { FrameLaterality: 'L' } }] }));
  assert.equal(f.render(), false);
});

test('CT/MR retain native decisions, configuration and arguments even across studies/FORs', () => {
  const f = fixture();
  for (const modality of ['CT', 'MR']) {
    f.images.set('source', { Modality: modality, FrameOfReferenceUID: 'source' });
    f.images.set('target', { Modality: modality, FrameOfReferenceUID: 'target', StudyInstanceUID: 'other' });
    assert.equal(f.render(), 'native result');
    f.tool.editData = null; assert.equal(f.render(), 'native result');
  }
  assert.equal(f.draws.length, 4);
});

test('mode exit restores tools and subscriptions; re-entry installs one wrapper', () => {
  const f = fixture();
  f.extension.onModeExit();
  assert.equal(f.tool.renderAnnotation, f.native);
  assert.equal(f.subscribers.size, 0);
  f.extension.onModeEnter(); f.extension.onModeEnter();
  f.images.set('target', f.image({ StudyInstanceUID: 'prior' }));
  assert.equal(f.render(), false);
  assert.equal(f.subscribers.size, 1);
  f.extension.onModeExit(); assert.equal(f.tool.renderAnnotation, f.native);
});
