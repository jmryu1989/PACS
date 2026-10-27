// REQ-MG-LENGTH-SCALE/FRAME/READBACK -> RISK-MG-WRONG-SCALE/FRAME/BASIS -> TEST-MG-LENGTH-BOUNDARY.
// Exercise the real reference parser, SR writer and shipped browser geometry with independent pixel distances.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const { viewerCommand, verifyViewerReference } = require('/app/dist/viewer-input.js');
const { srMeasurement, srDataset, srFile } = require('/app/dist/manual-sr-dicom.js');
const { mgGeometry } = require('/app/dist/mg-geometry.js');
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(require('node:path').join(__dirname, '../config/ohif/mg-length.js'), 'utf8'), ctx);
const base = { Modality: 'MG', StudyInstanceUID: '2.25.1', SeriesInstanceUID: '2.25.2', SOPInstanceUID: '2.25.3',
  SOPClassUID: '1.2.840.10008.5.1.4.1.1.1.2', Rows: 256, Columns: 256 };
const request = item => viewerCommand(Buffer.from(JSON.stringify({ requestId: '00000000-0000-4000-8000-000000000001', item })), true).item;
function item(tags, points, expected, basis, frame = 1, normal = [1, 0, 0], up = [0, 0, 1]) {
  return request({ schemaVersion: 1, kind: 'length', seriesUid: tags.SeriesInstanceUID, sopUid: tags.SOPInstanceUID,
    frame, frameOfReferenceUid: tags.FrameOfReferenceUID || null, label: 'Manual', points,
    viewPlaneNormal: normal, viewUp: up, baseline: { calculator: 'kin-mg-length-v1:' + basis, values: [expected] } });
}
const bad = fn => assert.throws(fn, e => e.getStatus?.() === 400);
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`); // Arithmetic roundoff, not a clinical tolerance.

test('projection precedence: PixelSpacing, ERMF correction, explicit detector plane; no spacing means no length', () => {
  for (const [extra, spacing, basis] of [
    [{ ImagerPixelSpacing: [.2, .4] }, [.2, .4], 'detector'],
    [{ ImagerPixelSpacing: '.2\\.4', EstimatedRadiographicMagnificationFactor: '2' }, [.1, .2], 'ermf'],
    [{ PixelSpacing: [.1, .3], ImagerPixelSpacing: [.2, .4], EstimatedRadiographicMagnificationFactor: 2 }, [.1, .3], 'pixel'],
    [{ PixelSpacing: [.1, .3], PixelSpacingCalibrationType: 'FIDUCIAL' }, [.1, .3], 'pixel'],
  ]) {
    const tags = { ...base, ...extra }, points = [[0, 0, 0], [0, 3 * spacing[1], -4 * spacing[0]]];
    const expected = Math.hypot(3 * spacing[1], 4 * spacing[0]), input = item(tags, points, expected, basis);
    verifyViewerReference('2.25.1', input, tags);
    for (const geometry of [mgGeometry(tags, 1), ctx.kinMgGeometry(tags, 1)]) {
      near(geometry.length(points), expected); assert.equal(geometry.calculator, input.baseline.calculator);
      assert.equal(geometry.frameOfReferenceUid, null);
    }
    const result = srMeasurement(input, tags);
    near(result.values[0], expected); result.graphic.forEach((n, i) => near(n, [.5, .5, 3.5, 4.5][i]));
    assert.ok(result.basis.includes(basis === 'detector' ? '검출기' : basis === 'ermf' ? 'ERMF' : 'PixelSpacing'));
    bad(() => verifyViewerReference('2.25.1', { ...input, baseline: { ...input.baseline, values: [expected + 1] } }, tags));
  }
  for (const extra of [{}, { PixelSpacing: [0, 1] }, { ImagerPixelSpacing: [1, 1], EstimatedRadiographicMagnificationFactor: 0 },
    { PixelSpacing: ['', 1] }, { PixelSpacing: [Infinity, 1] }]) {
    bad(() => mgGeometry({ ...base, ...extra }, 1));
    assert.throws(() => ctx.kinMgGeometry({ ...base, ...extra }, 1));
  }
});

const enhanced = () => ({ ...base, SOPClassUID: '1.2.840.10008.5.1.4.1.1.13.1.3', NumberOfFrames: 2,
  FrameOfReferenceUID: '2.25.4', ImageType: ['DERIVED', 'PRIMARY', 'TOMOSYNTHESIS', 'NONE'],
  SharedFunctionalGroupsSequence: [{ PlaneOrientationSequence: [{ ImageOrientationPatient: [1, 0, 0, 0, 1, 0] }],
    PixelMeasuresSequence: [{ PixelSpacing: [.1, .2] }] }],
  PerFrameFunctionalGroupsSequence: [
    { PlanePositionSequence: [{ ImagePositionPatient: [0, 0, 0] }] },
    { PlanePositionSequence: [{ ImagePositionPatient: [0, 0, 5] }], PixelMeasuresSequence: [{ PixelSpacing: [.3, .4] }] },
  ], PixelSpacing: [99, 99], ImagePositionPatient: [0, 0, 999] });

test('DBT resolves the selected frame before shared attributes, never the mutated instance; SR references the frame', () => {
  const tags = enhanced(), points = [[0, 0, 5], [1.2, 1.2, 5]], expected = Math.hypot(1.2, 1.2);
  const input = item(tags, points, expected, 'dbt', 2, [0, 0, 1], [0, 1, 0]);
  verifyViewerReference('2.25.1', input, tags);
  near(ctx.kinMgGeometry(tags, 2).length(points), expected);
  bad(() => verifyViewerReference('2.25.1', { ...input, frame: 1 }, tags));
  bad(() => verifyViewerReference('2.25.1', { ...input, frame: 3 }, tags));
  const missing = enhanced(); delete missing.PerFrameFunctionalGroupsSequence[1].PlanePositionSequence;
  bad(() => mgGeometry(missing, 2));
  const computed = srMeasurement(input, tags);
  near(computed.graphic[2], 3.5); near(computed.graphic[3], 4.5);
  const dataset = srDataset('sr-1', '2.25.1', 'Reader', 'reader', new Date('2026-10-26'), [{ head: { id: 'm-1', revision: 1, snapshot: input }, tags, computed }], 1);
  const group = dataset.ContentSequence.at(-1).ContentSequence[0].ContentSequence;
  const ref = group[3].ContentSequence.ContentSequence.ReferencedSOPSequence;
  assert.equal(ref.ReferencedFrameNumber, 2); assert.equal(ref.ReferencedSOPInstanceUID, input.sopUid);
  assert.ok(group[2].TextValue.includes('DBT PixelSpacing')); assert.ok(srFile(dataset).includes(Buffer.from('DBT PixelSpacing')));
});

test('Synthetic 2D in a DBT SOP keeps a projection basis; rounded MLO cosines retain exact pixel scale', () => {
  const tags = enhanced(); tags.ImageType[2] = 'GENERATED_2D';
  const points = [[0, 0, 5], [4, 0, 5]], input = item(tags, points, 4, 'pixel', 2, [0, 0, 1], [0, 1, 0]);
  verifyViewerReference('2.25.1', input, tags); assert.ok(srMeasurement(input, tags).basis.includes('원본 기준면'));
  tags.SharedFunctionalGroupsSequence[0].PlaneOrientationSequence[0].ImageOrientationPatient = [0, 1, 0, .708, 0, -.706];
  const oblique = [[0, 0, 5], [.708 * 3, 4, 5 - .706 * 3]];
  near(mgGeometry(tags, 2).length(oblique), 5); near(ctx.kinMgGeometry(tags, 2).length(oblique), 5);
  const n = [.706, 0, .708], size = Math.hypot(...n);
  verifyViewerReference('2.25.1', item(tags, oblique, 5, 'pixel', 2, n.map(x => x / size), [.708, 0, -.706]), tags);
});

test('enhanced projection resolves detector spacing and ERMF per frame without borrowing another frame', () => {
  const tags = enhanced(); tags.SOPClassUID = '1.2.840.10008.5.1.4.1.1.13.1.4';
  delete tags.SharedFunctionalGroupsSequence[0].PixelMeasuresSequence;
  delete tags.PerFrameFunctionalGroupsSequence[1].PixelMeasuresSequence;
  tags.SharedFunctionalGroupsSequence[0].FramePixelDataPropertiesSequence = [{ ImagerPixelSpacing: [.2, .4] }];
  tags.SharedFunctionalGroupsSequence[0].XRayGeometrySequence = [{ EstimatedRadiographicMagnificationFactor: 2 }];
  const points = [[0, 0, 5], [.6, .4, 5]], length = Math.hypot(.6, .4);
  const input = item(tags, points, length, 'ermf', 2, [0, 0, 1], [0, 1, 0]);
  verifyViewerReference('2.25.1', input, tags);
  near(ctx.kinMgGeometry(tags, 2).length(points), length);
  delete tags.SharedFunctionalGroupsSequence[0].FramePixelDataPropertiesSequence;
  tags.ImagerPixelSpacing = [.2, .4]; // A native combiner's last-frame top-level residue.
  bad(() => mgGeometry(tags, 2));
  assert.throws(() => ctx.kinMgGeometry(tags, 2));
});

test('CT remains native, MR/XA remain unsupported and MG angle/ROI cannot enter through the length contract', () => {
  const tags = { ...base, Modality: 'CT', SOPClassUID: '1.2.840.10008.5.1.4.1.1.2', FrameOfReferenceUID: '2.25.4',
    ImagePositionPatient: [0, 0, 0], ImageOrientationPatient: [1, 0, 0, 0, 1, 0], PixelSpacing: [1, 1] };
  const input = { ...item(tags, [[0, 0, 0], [3, 4, 0]], 5, 'pixel', 1, [0, 0, 1], [0, 1, 0]), baseline: { calculator: 'kin-native-manual-v1', values: [5] } };
  verifyViewerReference('2.25.1', input, tags); assert.deepEqual(srMeasurement(input, tags).values, [5]);
  for (const [modality, sop] of [['MR', '1.2.840.10008.5.1.4.1.1.4'], ['XA', '1.2.840.10008.5.1.4.1.1.12.1'], ['MG', base.SOPClassUID]]) {
    const source = { ...tags, Modality: modality, SOPClassUID: sop };
    bad(() => verifyViewerReference('2.25.1', input, source));
    bad(() => verifyViewerReference('2.25.1', { ...input, kind: 'angle' }, source));
  }
});
