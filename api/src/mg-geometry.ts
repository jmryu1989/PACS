import { BadRequestException } from '@nestjs/common';

// MG coordinates stay in the source image plane. Projection fallbacks are image-local,
// never a claimed patient Frame of Reference; the SOP/frame still identifies the image.
export function mgGeometry(tags: any, frame: number) {
  const dbt = '1.2.840.10008.5.1.4.1.1.13.1.3';
  const enhanced = [dbt, '1.2.840.10008.5.1.4.1.1.13.1.4', '1.2.840.10008.5.1.4.1.1.13.1.5'];
  const classic = ['1.2.840.10008.5.1.4.1.1.1.2', '1.2.840.10008.5.1.4.1.1.1.2.1'];
  if (tags?.Modality !== 'MG' || ![...enhanced, ...classic].includes(tags.SOPClassUID)) return null;
  const fail = () => { throw new BadRequestException('MG 원본 프레임의 좌표·간격·보정을 확인할 수 없습니다'); };
  const numbers = (value, count) => {
    const fields = typeof value === 'string' ? value.split('\\') : Array.isArray(value) ? value : [value];
    if (fields.length !== count || fields.some(n => !(typeof n === 'number' || typeof n === 'string' && n.trim()) || !Number.isFinite(Number(n)))) return fail();
    return fields.map(Number);
  };
  const many = enhanced.includes(tags.SOPClassUID), frames = many ? Number(tags.NumberOfFrames) : 1;
  if (!Number.isSafeInteger(frames) || frames < 1 || !Number.isSafeInteger(frame) || frame < 1 || frame > frames ||
      !many && tags.NumberOfFrames !== undefined && Number(tags.NumberOfFrames) !== 1) return fail();
  const shared = tags.SharedFunctionalGroupsSequence?.[0], per = tags.PerFrameFunctionalGroupsSequence?.[frame - 1];
  if (many && tags.PerFrameFunctionalGroupsSequence !== undefined && (!Array.isArray(tags.PerFrameFunctionalGroupsSequence) || tags.PerFrameFunctionalGroupsSequence.length !== frames)) return fail();
  // Enhanced objects must resolve this frame's functional groups. The pinned native
  // combiner mutates top-level attributes, which can still contain another frame.
  const value = (sequence, key) => many ? (per?.[sequence]?.[0] ?? shared?.[sequence]?.[0])?.[key] : tags[key];
  const type = value('XRay3DFrameTypeSequence', 'FrameType') ?? tags.ImageType;
  const types = Array.isArray(type) ? type : String(type || '').split('\\');
  const tomographic = tags.SOPClassUID === dbt && !types.includes('GENERATED_2D');
  let spacing, basis;
  const pixel = value('PixelMeasuresSequence', 'PixelSpacing');
  if (pixel !== undefined) {
    spacing = numbers(pixel, 2); basis = tomographic ? 'dbt' : 'pixel';
  } else {
    if (tomographic) return fail();
    spacing = numbers(value('FramePixelDataPropertiesSequence', 'ImagerPixelSpacing'), 2);
    const factor = value('XRayGeometrySequence', 'EstimatedRadiographicMagnificationFactor');
    if (factor !== undefined) {
      const magnification = numbers(factor, 1)[0]; if (magnification <= 0) return fail();
      spacing = spacing.map(n => n / magnification); basis = 'ermf';
    } else basis = 'detector';
  }
  if (spacing.some(n => !Number.isFinite(n) || n <= 0)) return fail();
  const ipp = value('PlanePositionSequence', 'ImagePositionPatient');
  const iop = value('PlaneOrientationSequence', 'ImageOrientationPatient');
  const origin = numbers(ipp === undefined && !tomographic ? [0, 0, 0] : ipp, 3);
  const orientation = numbers(iop === undefined && !tomographic ? [0, 1, 0, 0, 0, -1] : iop, 6);
  if (tomographic && !tags.FrameOfReferenceUID) return fail();
  const rows = Number(tags.Rows), columns = Number(tags.Columns);
  if (![rows, columns].every(n => Number.isSafeInteger(n) && n > 0 && n <= 65535)) return fail();
  const u = orientation.slice(0, 3), v = orientation.slice(3), dot = (a, b) => a.reduce((s, n, i) => s + n * b[i], 0);
  const uu = dot(u, u), vv = dot(v, v), uv = dot(u, v), det = uu * vv - uv * uv;
  // Rounded DICOM direction cosines (e.g. EA1141 MLO) need their inverse matrix,
  // not the unit-vector shortcut. The existing plane orthogonality tolerance applies.
  if (uu <= 0 || vv <= 0 || det <= 0 || Math.abs(uv / Math.sqrt(uu * vv)) > 1e-4) return fail();
  const cross = [u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]];
  const normal = cross.map(n => n / Math.sqrt(dot(cross, cross)));
  const imagePoint = point => {
    const d = numbers(point, 3).map((n, i) => n - origin[i]);
    const x = (dot(d, u) * vv - dot(d, v) * uv) / det / spacing[1];
    const y = (dot(d, v) * uu - dot(d, u) * uv) / det / spacing[0];
    if (Math.abs(dot(d, normal)) > .001 || x < -.501 || y < -.501 || x > columns - .499 || y > rows - .499) return fail();
    return [x, y];
  };
  const length = points => {
    const a = imagePoint(points[0]), b = imagePoint(points[1]);
    return Math.hypot((b[0] - a[0]) * spacing[1], (b[1] - a[1]) * spacing[0]);
  };
  const label = { dbt: 'DBT PixelSpacing', pixel: 'PixelSpacing · 원본 기준면',
    ermf: 'ImagerPixelSpacing / ERMF · 추정 보정', detector: 'ImagerPixelSpacing · 검출기 기준' }[basis];
  return { origin, orientation, spacing, normal, imagePoint, length, basis, label,
    frameOfReferenceUid: tags.FrameOfReferenceUID || null, calculator: 'kin-mg-length-v1:' + basis };
}
