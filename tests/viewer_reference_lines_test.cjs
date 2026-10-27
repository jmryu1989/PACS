// REQ-MG-03 -> RISK-MG-FALSE-ANATOMY -> TEST-MG-REFERENCE-LINES.
// REQ-VIEWER-REFERENCE-PLANE -> RISK-VIEWER-REFERENCE-PLANE -> TEST-VIEWER-REFERENCE-PLANE.
// Registered in tests/README.md: stacks use the displayed frame's stored plane;
// MPR uses the volume's source planes/FoR and native camera geometry.
// Exercise the shipped extension's tool lifecycle/render boundary. Native geometry
// and SVG removal are checked separately on the served viewer with public samples.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');

function fixture(before = false) {
  const images = new Map(), viewports = new Map(), groups = new Map(), subscribers = new Set();
  const draws = [], metadataReads = [];
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
    metaData: { get(type, id) {
      if (type === 'instance') { metadataReads.push(id); return images.get(id); }
      return { rowCosines: [0, 1, 0], columnCosines: [0, 0, -1], imagePositionPatient: [0, 0, 0] };
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
    const viewport = { type: 'stack', getCurrentImageId: () => id, getImageIds: () => [id] };
    viewports.set(id, viewport); return { viewport };
  }
  pane('source', image());
  const target = pane('target', image()), svg = {};
  function volumePane(id, values, frame = values[0]?.FrameOfReferenceUID) {
    const ids = values.map((value, index) => {
      const key = `${id}-volume-${index}`; images.set(key, value); return key;
    });
    const viewport = { type: 'orthographic', getCurrentImageId: () => undefined,
      getVolumeId: () => `${id}-volume`, getImageIds: () => ids, getFrameOfReferenceUID: () => frame };
    viewports.set(id, viewport); return { viewport };
  }
  return { extension, tool, native, image, images, pane, volumePane, groups, subscribers, draws, metadataReads,
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


test('CT/MR MPR without current image IDs preserves native drawing in all anatomical plane directions', () => {
  for (const Modality of ['CT', 'MR']) {
    const f = fixture(), images = [f.image({ Modality }), f.image({ Modality, ImagePositionPatient: [0, 0, 1] })];
    const panes = ['axial', 'sagittal', 'coronal'].map(id => f.volumePane(id, images));
    // Only the acquisition plane may have a current image; it is not the MPR identity.
    panes[0].viewport.getCurrentImageId = () => 'axial-volume-0';
    for (const source of ['axial', 'sagittal', 'coronal']) {
      f.tool.editData.sourceViewportId = source;
      for (const target of panes) {
        assert.equal(f.tool.renderAnnotation(target, f.svg), 'native result');
      }
    }
  }
});

test('volume/stack pairs share coordinates in both directions; stack never borrows another frame plane', () => {
  const f = fixture(), image = f.image({ Modality: 'CT' });
  const volume = f.volumePane('volume', [image]);
  f.images.set('target', image);
  f.tool.editData.sourceViewportId = 'volume'; assert.equal(f.render(), 'native result');
  f.tool.editData.sourceViewportId = 'target';
  assert.equal(f.tool.renderAnnotation(volume, f.svg), 'native result');
  f.target.viewport.getCurrentImageId = () => undefined;
  assert.equal(f.tool.renderAnnotation(volume, f.svg), false);
  f.tool.editData.sourceViewportId = 'volume'; assert.equal(f.render(), false);
});

test('MPR checks the whole displayed volume and rechecks replacement on either pane', () => {
  for (const changed of ['source', 'target']) {
    const f = fixture(), image = f.image({ Modality: 'CT' });
    function render(values, frame = 'frame') {
      const source = f.volumePane('source', changed === 'source' ? values : [image], changed === 'source' ? frame : 'frame');
      const target = f.volumePane('target', changed === 'target' ? values : [image], changed === 'target' ? frame : 'frame');
      return f.tool.renderAnnotation(target, f.svg);
    }
    assert.equal(render([image, image]), 'native result');
    for (const invalid of [{ ImagePositionPatient: undefined }, { ImageOrientationPatient: undefined },
      { StudyInstanceUID: 'prior' }, { StudyInstanceUID: '' }, { FrameOfReferenceUID: 'other' },
      { FrameOfReferenceUID: '' }, { Modality: 'MG' }]) {
      assert.equal(render([image, { ...image, ...invalid }]), false, JSON.stringify(invalid));
    }
    assert.equal(render([]), false);
    assert.equal(render([image], ''), false);
    assert.equal(render([image], 'other'), false);
    assert.equal(render([{ ...image, StudyInstanceUID: 'prior' }]), false);
    assert.equal(render([image, image]), 'native result');
  }
});


test('MPR creation, replacement and teardown without a volume draw nothing and recover after setVolumes', () => {
  for (const changed of ['source', 'target']) {
    const f = fixture(), image = f.image({ Modality: 'CT' });
    const source = f.volumePane('source', [image]), target = f.volumePane('target', [image]);
    const viewport = (changed === 'source' ? source : target).viewport;
    const volumeId = viewport.getVolumeId, imageIds = viewport.getImageIds;
    const render = () => f.tool.renderAnnotation(target, f.svg);
    // Pinned cornerstone throws when the actor or its cached volume is absent.
    viewport.getVolumeId = () => undefined;
    viewport.getImageIds = () => { throw new Error('No actor found for the given volumeId: undefined'); };
    assert.equal(render(), false);
    viewport.getVolumeId = volumeId;
    assert.equal(render(), false);
    assert.equal(f.draws.length, 0);
    viewport.getImageIds = imageIds;
    assert.equal(render(), 'native result');
    viewport.getImageIds = () => { throw new Error('imageVolume does not exist in cache'); };
    assert.equal(render(), false);
    viewport.getImageIds = imageIds;
    assert.equal(render(), 'native result');
  }
});

test('MPR camera renders share one metadata pass per volume and replacement rechecks its sources', () => {
  const f = fixture(), image = f.image({ Modality: 'CT' });
  const source = f.volumePane('source', [image, image]);
  const target = f.volumePane('target', [image, image]);
  const render = () => f.tool.renderAnnotation(target, f.svg);
  // Orthographic panes of the same cached volume expose the same source array.
  target.viewport.getVolumeId = source.viewport.getVolumeId;
  target.viewport.getImageIds = source.viewport.getImageIds;
  assert.equal(render(), 'native result');
  assert.equal(f.metadataReads.length, 2);
  assert.equal(render(), 'native result');
  assert.equal(f.metadataReads.length, 2);
  target.viewport.getFrameOfReferenceUID = () => 'other';
  assert.equal(render(), false);
  target.viewport.getFrameOfReferenceUID = () => 'frame';
  assert.equal(render(), 'native result');
  assert.equal(f.metadataReads.length, 2);
  const replacement = f.volumePane('replacement', [image, { ...image, ImagePositionPatient: undefined }]);
  target.viewport.getVolumeId = replacement.viewport.getVolumeId;
  target.viewport.getImageIds = replacement.viewport.getImageIds;
  assert.equal(render(), false);
  assert.equal(f.metadataReads.length, 4);
  assert.equal(render(), false);
  assert.equal(f.metadataReads.length, 4);
  // Replacing the cached volume under the same ID also invalidates a negative verdict.
  const restored = f.volumePane('replacement', [image, image]);
  target.viewport.getImageIds = restored.viewport.getImageIds;
  assert.equal(render(), 'native result');
  assert.equal(f.metadataReads.length, 6);
  assert.equal(render(), 'native result');
  assert.equal(f.metadataReads.length, 6);
  f.extension.onModeExit(); f.extension.onModeEnter();
  assert.equal(render(), 'native result');
  assert.equal(f.metadataReads.length, 10);
});
