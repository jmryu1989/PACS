// REQ-MG-03 -> RISK-MG-FALSE-ANATOMY -> TEST-MG-REFERENCE-LINES.
// REQ-VIEWER-REFERENCE-PLANE -> RISK-MG-FALSE-ANATOMY -> TEST-VIEWER-REFERENCE-PLANE:
// 2026-10-26 fix order F1/F3: every modality pair must share study/FoR and
// carry stored IOP/IPP for both displayed frames; MG also retains its side gate.
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
    metaData: { get: (type, id) => type === 'instance' ? images.get(id) : {
      rowCosines: [0, 1, 0], columnCosines: [0, 0, -1], imagePositionPatient: [0, 0, 0],
    } },
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
  const image = overrides => ({ Modality: 'MG', StudyInstanceUID: 'study', FrameOfReferenceUID: 'frame', ImageLaterality: 'R',
    ImageOrientationPatient: [1, 0, 0, 0, 1, 0], ImagePositionPatient: [0, 0, 0], ...overrides });
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

test('every modality requires a stored displayed-frame plane on both panes despite native defaults', () => {
  for (const modality of ['MG', 'CT', 'MR']) {
    for (const pane of ['source', 'target']) {
      const f = fixture(), image = f.image({ Modality: modality });
      f.images.set('source', image); f.images.set('target', image);
      assert.equal(f.render(), 'native result');
      for (const invalid of [
        { ImageOrientationPatient: undefined }, { ImagePositionPatient: undefined },
        { ImageOrientationPatient: [] }, { ImagePositionPatient: [0, 0] },
        { ImageOrientationPatient: [1, 0, 0, 0, NaN, 0] }, { ImagePositionPatient: [0, Infinity, 0] },
        { ImagePositionPatient: ['0', '', '0'] }, { ImagePositionPatient: ['0', null, '0'] },
        // Functional groups alone must not qualify a plane that this provider has
        // not resolved into its displayed-frame instance (the #239 boundary).
        { ImageOrientationPatient: undefined, SharedFunctionalGroupsSequence: [{
          PlaneOrientationSequence: [{ ImageOrientationPatient: image.ImageOrientationPatient }],
        }] },
      ]) {
        f.images.set(pane, { ...image, ...invalid });
        assert.equal(f.render(), false, `${modality} ${pane} ${JSON.stringify(invalid)}`);
      }
      assert.equal(f.draws.length, 1);
      f.images.set(pane, image); assert.equal(f.render(), 'native result');
    }
  }
});

test('stored DICOM decimal strings from the served provider qualify in both panes for every modality', () => {
  for (const Modality of ['MG', 'CT', 'MR']) {
    const f = fixture();
    const image = f.image({ Modality, ImageOrientationPatient: ['1', '6.123031769e-017', '0', '0', '0', '-1'],
      ImagePositionPatient: ['-255.5', '-190', '-168'] });
    f.images.set('source', image); f.images.set('target', image);
    assert.equal(f.render(), 'native result');
  }
});

test('CT/MR allow shared coordinates and refuse different or missing study/FoR in either pane', () => {
  for (const [sourceModality, targetModality] of [['CT', 'CT'], ['MR', 'MR'], ['CT', 'MR'], ['MR', 'CT']]) {
    for (const pane of ['source', 'target']) {
      const f = fixture();
      f.images.set('source', f.image({ Modality: sourceModality }));
      f.images.set('target', f.image({ Modality: targetModality }));
      const image = f.images.get(pane);
      assert.equal(f.render(), 'native result');
      for (const invalid of [{ FrameOfReferenceUID: 'other' }, { FrameOfReferenceUID: undefined },
        { FrameOfReferenceUID: '' }, { StudyInstanceUID: 'other' }, { StudyInstanceUID: undefined }, { StudyInstanceUID: '' }]) {
        f.images.set(pane, { ...image, ...invalid });
        assert.equal(f.render(), false);
      }
      f.images.set(pane, image); assert.equal(f.render(), 'native result');
      f.images.delete(pane); assert.equal(f.render(), false);
      f.images.set(pane, image); f.tool.editData = null; assert.equal(f.render(), false);
      assert.equal(f.draws.length, 2);
    }
  }
});

test('scrolling to an image without a plane clears eligibility and returning restores it', () => {
  const f = fixture();
  f.images.set('no-plane', f.image({ ImagePositionPatient: undefined }));
  for (const viewport of [f.target.viewport, f.pane('source', f.image()).viewport]) {
    const current = viewport.getCurrentImageId;
    assert.equal(f.render(), 'native result');
    viewport.getCurrentImageId = () => 'no-plane'; assert.equal(f.render(), false);
    viewport.getCurrentImageId = current; assert.equal(f.render(), 'native result');
  }
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
