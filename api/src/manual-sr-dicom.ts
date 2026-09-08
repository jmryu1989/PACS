import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';

export const SR_CLASS = '1.2.840.10008.5.1.4.1.1.88.33';
const syntax = '1.2.840.10008.1.2.1';
export const srUid = (text: string) => '2.25.' + BigInt('0x' + createHash('sha256').update(text).digest('hex').slice(0, 32)).toString();
const invalid = (): never => { throw new BadRequestException('SR 원본 수치 또는 형식을 확인할 수 없습니다'); };
const vector = (x: any) => (Array.isArray(x) ? x : String(x).split('\\')).map(Number);
const sub = (a: number[], b: number[]) => a.map((n, i) => n - b[i]);
const dot = (a: number[], b: number[]) => a.reduce((s, n, i) => s + n * b[i], 0);
const norm = (a: number[]) => Math.sqrt(dot(a, a));

// Only Orthanc's uncompressed, C-order single-frame grayscale NPY response is
// accepted. Parse its literal header; never evaluate the Python dictionary.
export function srPixels(raw: Buffer, rows: number, cols: number): (i: number) => number {
  if (!Buffer.isBuffer(raw) || raw.length < 12 || raw.subarray(0, 6).toString('hex') !== '934e554d5059') invalid();
  const major = raw[6], offset = major === 1 ? 10 : major === 2 ? 12 : invalid();
  const length = major === 1 ? raw.readUInt16LE(8) : raw.readUInt32LE(8);
  if (length > 4096 || offset + length > raw.length) invalid();
  const header = raw.subarray(offset, offset + length).toString('ascii');
  const dtype = header.match(/'descr':\s*'(<[fiu][248]|\|[iu]1)'/)?.[1];
  const shape = header.match(/'shape':\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,?\s*\)/);
  if (!dtype || !/'fortran_order':\s*False/.test(header) || !shape ||
      shape.slice(1).map(Number).join(',') !== [1, rows, cols, 1].join(',')) invalid();
  const readers: Record<string, [number, (offset: number) => number]> = {
    '<f4': [4, p => raw.readFloatLE(p)], '<f8': [8, p => raw.readDoubleLE(p)],
    '<i2': [2, p => raw.readInt16LE(p)], '<u2': [2, p => raw.readUInt16LE(p)],
    '<i4': [4, p => raw.readInt32LE(p)], '<u4': [4, p => raw.readUInt32LE(p)],
    '|i1': [1, p => raw.readInt8(p)], '|u1': [1, p => raw.readUInt8(p)],
  };
  const [bytes, read] = readers[dtype] || invalid(), start = offset + length;
  if (rows * cols > 4194304 || raw.length !== start + rows * cols * bytes) invalid();
  return i => { const n = read(start + i * bytes); return Number.isFinite(n) ? n : invalid(); };
}

export function srMeasurement(item: any, tags: any, pixels?: Buffer) {
  const p = item.points, origin = vector(tags.ImagePositionPatient), orientation = vector(tags.ImageOrientationPatient), spacing = vector(tags.PixelSpacing);
  const u = orientation.slice(0, 3), v = orientation.slice(3), uu = dot(u, u), vv = dot(v, v), uv = dot(u, v), det = uu * vv - uv * uv;
  const image = (point: number[]) => {
    const d = sub(point, origin);
    // DICOM SCOORD starts at the upper-left pixel corner; world coordinates
    // describe pixel centers. This matches the pinned worldToImageCoords.
    return [(dot(d, u) * vv - dot(d, v) * uv) / det / spacing[1] + .5,
      (dot(d, v) * uu - dot(d, u) * uv) / det / spacing[0] + .5];
  };
  let values: number[], graphic = p;
  if (item.kind === 'length') values = [norm(sub(p[1], p[0]))];
  else if (item.kind === 'angle') {
    const a = sub(p[0], p[1]), b = sub(p[2], p[1]);
    values = [Math.acos(Math.max(-1, Math.min(1, dot(a, b) / norm(a) / norm(b)))) * 180 / Math.PI];
  } else {
    const rows = Number(tags.Rows), cols = Number(tags.Columns), read = srPixels(pixels, rows, cols);
    const a = sub(p[0], p[1]), b = sub(p[3], p[2]), ra = norm(a) / 2, rb = norm(b) / 2;
    const center = p[0].map((n: number, i: number) => (n + p[1][i]) / 2);
    let sum = 0, count = 0, min = Infinity, max = -Infinity;
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const d = origin.map((n, i) => n + u[i] * spacing[1] * x + v[i] * spacing[0] * y - center[i]);
      if ((dot(d, a) / (2 * ra * ra)) ** 2 + (dot(d, b) / (2 * rb * rb)) ** 2 > 1) continue;
      const n = read(y * cols + x) * Number(tags.RescaleSlope) + Number(tags.RescaleIntercept);
      if (!Number.isFinite(n)) invalid(); sum += n; count++; min = Math.min(min, n); max = Math.max(max, n);
    }
    if (!count) invalid();
    values = [Math.PI * ra * rb, sum / count, min, max, count];
    // ELLIPSE requires the major-axis pair before the minor-axis pair.
    graphic = ra >= rb ? p : [p[2], p[3], p[0], p[1]];
  }
  const saved = item.baseline?.values;
  const tolerance = item.kind === 'ellipse' ? .01 : .001;
  if (!saved || saved.length !== values.length || values.some((n, i) => !Number.isFinite(n) ||
      Math.abs(n - saved[i]) > (i === 0 ? tolerance : i === 1 ? .001 : 0)))
    throw new ConflictException('재확인 필요: 원본으로 계산한 값이 저장한 측정과 다릅니다');
  return { values, graphic: graphic.flatMap(image) };
}

const code = (CodeValue: string, CodeMeaning: string, CodingSchemeDesignator = 'DCM') => ({ CodeValue, CodingSchemeDesignator, CodeMeaning });
const node = (ValueType: string, name: any, fields: any = {}, RelationshipType = 'CONTAINS') =>
  ({ RelationshipType, ValueType, ConceptNameCodeSequence: name, ...fields });
const dsNumber = (n: number) => { for (let precision = 14; precision > 1; precision--) { const s = Number(n.toPrecision(precision)).toString(); if (s.length <= 16) return s; } return invalid(); };
const srText = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/g, ' ');
// An account identifier is an unstructured display name, not PN components.
// The exact author subject remains in the immutable server receipt/audit.
const observerName = (s: string) => Array.from(srText(s).replace(/[\\^=\t\r\n\f]/g, ' ')).slice(0, 64).join('');

export function srDataset(id: string, studyUid: string, actor: string, authorSub: string, at: Date, entries: any[], instanceNumber: number) {
  const first = entries[0].tags, when = at.toISOString(), date = when.slice(0, 10).replace(/-/g, ''), time = when.slice(11, 23).replace(/:/g, '');
  const groups = entries.map(({ head, tags, computed }) => {
    const item = head.snapshot, tool = { length: 'Length', angle: 'Angle', ellipse: 'EllipticalROI' }[item.kind];
    const image = node('IMAGE', code('121324', 'Source image'), { ReferencedSOPSequence: {
      ReferencedSOPClassUID: tags.SOPClassUID, ReferencedSOPInstanceUID: item.sopUid,
    } }, 'SELECTED FROM');
    const coords = node('SCOORD', code('111030', 'Image Region'), {
      GraphicType: item.kind === 'ellipse' ? 'ELLIPSE' : 'POLYLINE', GraphicData: computed.graphic, ContentSequence: image,
    }, 'INFERRED FROM');
    const metric = item.kind === 'length' ? code('410668003', 'Length', 'SCT') : item.kind === 'angle' ? code('C25323', 'Angle', 'NCIt') : code('42798000', 'Area', 'SCT');
    const unit = item.kind === 'length' ? code('mm', 'millimeter', 'UCUM') : item.kind === 'angle' ? code('deg', 'degree', 'UCUM') : code('mm2', 'square millimeter', 'UCUM');
    const numeric = (name: any, value: number, units: any, extra: any = {}) => node('NUM', name, {
      MeasuredValueSequence: { NumericValue: dsNumber(value), MeasurementUnitsCodeSequence: units }, ...extra,
    });
    const contents = [
      node('TEXT', code('112039', 'Tracking Identifier'), { TextValue: 'KIN manual v1:' + tool }, 'HAS OBS CONTEXT'),
      node('UIDREF', code('112040', 'Tracking Unique Identifier'), { UID: srUid('measurement:' + head.id) }, 'HAS OBS CONTEXT'),
      node('TEXT', code('121106', 'Comment'), { TextValue: srText(item.label || tool) + ' [revision ' + head.revision + ']' }),
      numeric(metric, computed.values[0], unit, { ContentSequence: coords }),
    ];
    if (item.kind === 'ellipse') {
      // Planar ROI measurements share a TID1410 image region. The region is a
      // sibling of the statistics, which avoids copying the same shape once
      // per numeric value and is understood by the pinned SR renderer.
      delete contents[3].ContentSequence;
      contents.push({ ...coords, RelationshipType: 'CONTAINS' });
      // These names describe local manual ROI statistics; private coding avoids
      // borrowing a standardized clinical concept with different semantics.
      for (const [index, key, title] of [[1, 'HU-MEAN', 'Mean CT attenuation'], [2, 'HU-MIN', 'Minimum CT attenuation'], [3, 'HU-MAX', 'Maximum CT attenuation']] as const)
        contents.push(numeric(code(key, title, '99KIN'), computed.values[index], code('[hnsf\'U]', 'Hounsfield unit', 'UCUM')));
      contents.push(numeric(code('PIXEL-COUNT', 'ROI pixel count', '99KIN'), computed.values[4], code('1', 'no units', 'UCUM')));
    }
    return node('CONTAINER', code('125007', 'Measurement Group'), { ContinuityOfContent: 'SEPARATE', ContentSequence: contents });
  });
  const series = new Map<string, any>();
  for (const { tags } of entries) {
    if (!series.has(tags.SeriesInstanceUID)) series.set(tags.SeriesInstanceUID, { SeriesInstanceUID: tags.SeriesInstanceUID, ReferencedSOPSequence: [] });
    const refs = series.get(tags.SeriesInstanceUID).ReferencedSOPSequence;
    if (!refs.some((x: any) => x.ReferencedSOPInstanceUID === tags.SOPInstanceUID)) refs.push({ ReferencedSOPClassUID: tags.SOPClassUID, ReferencedSOPInstanceUID: tags.SOPInstanceUID });
  }
  const dataset: any = {
    SpecificCharacterSet: 'ISO_IR 192', SOPClassUID: SR_CLASS, SOPInstanceUID: srUid('report:' + id), StudyInstanceUID: studyUid,
    SeriesInstanceUID: srUid('manual-series:' + studyUid + ':' + authorSub), Modality: 'SR', Manufacturer: 'KIN',
    ManufacturerModelName: 'Manual measurement report', SoftwareVersions: 'kin-manual-sr-v1',
    SeriesDescription: 'KIN manual measurements', SeriesNumber: 9001, InstanceNumber: instanceNumber,
    InstanceCreationDate: date, InstanceCreationTime: time, SeriesDate: date, SeriesTime: time, ContentDate: date, ContentTime: time,
    // A global offset would reinterpret copied, possibly unqualified StudyTime.
    // The immutable server receipt/audit retain the exact UTC creation instant.
    CompletionFlag: 'COMPLETE', VerificationFlag: 'UNVERIFIED', PreliminaryFlag: 'PRELIMINARY',
    ReferencedPerformedProcedureStepSequence: [], PerformedProcedureCodeSequence: [],
    ValueType: 'CONTAINER', ConceptNameCodeSequence: code('126000', 'Imaging Measurement Report'), ContinuityOfContent: 'SEPARATE',
    ContentTemplateSequence: { MappingResource: 'DCMR', TemplateIdentifier: '1500' },
    CurrentRequestedProcedureEvidenceSequence: [{ StudyInstanceUID: studyUid, ReferencedSeriesSequence: [...series.values()] }],
    ContentSequence: [
      node('CODE', code('121049', 'Language of Content Item and Descendants'), { ConceptCodeSequence: code('en-US', 'English (United States)', 'RFC5646') }, 'HAS CONCEPT MOD'),
      node('CODE', code('121005', 'Observer Type'), { ConceptCodeSequence: code('121006', 'Person') }, 'HAS OBS CONTEXT'),
      node('PNAME', code('121008', 'Person Observer Name'), { PersonName: observerName(actor) }, 'HAS OBS CONTEXT'),
      node('CODE', code('121058', 'Procedure reported'), { ConceptCodeSequence: code('P5-08000', 'Computed Tomography', 'SRT') }, 'HAS CONCEPT MOD'),
      node('CONTAINER', code('111028', 'Image Library'), { ContinuityOfContent: 'SEPARATE', ContentSequence: [
        node('CONTAINER', code('126200', 'Image Library Group'), { ContinuityOfContent: 'SEPARATE', ContentSequence:
          [...series.values()].flatMap(s => s.ReferencedSOPSequence.map(ref => node('IMAGE', code('121324', 'Source image'), { ReferencedSOPSequence: ref }))), }),
      ] }),
      node('CONTAINER', code('126010', 'Imaging Measurements'), { ContinuityOfContent: 'SEPARATE', ContentSequence: groups }),
    ],
  };
  for (const key of ['PatientName', 'PatientID', 'PatientBirthDate', 'PatientSex', 'StudyDate', 'StudyTime', 'AccessionNumber', 'StudyID', 'ReferringPhysicianName']) dataset[key] = first[key] || '';
  for (const key of ['InstitutionName', 'StudyDescription']) if (first[key]) dataset[key] = first[key];
  return dataset;
}

// This is an encoder for the tags emitted above, not a general DICOM parser or
// arbitrary browser-supplied dataset serializer. Unknown keys fail closed.
const dictionary: Record<string, [number, string]> = {};
for (const row of [
  '00080005 CS SpecificCharacterSet', '00080012 DA InstanceCreationDate', '00080013 TM InstanceCreationTime', '00080016 UI SOPClassUID', '00080018 UI SOPInstanceUID',
  '00080020 DA StudyDate', '00080021 DA SeriesDate', '00080023 DA ContentDate', '00080030 TM StudyTime', '00080031 TM SeriesTime', '00080033 TM ContentTime',
  '00080050 SH AccessionNumber', '00080060 CS Modality', '00080070 LO Manufacturer', '00080080 LO InstitutionName', '00080090 PN ReferringPhysicianName',
  '00080100 SH CodeValue', '00080102 SH CodingSchemeDesignator', '00080104 LO CodeMeaning', '00080105 CS MappingResource',
  '00081030 LO StudyDescription', '0008103e LO SeriesDescription', '00081090 LO ManufacturerModelName', '00081111 SQ ReferencedPerformedProcedureStepSequence',
  '00081115 SQ ReferencedSeriesSequence', '00081150 UI ReferencedSOPClassUID', '00081155 UI ReferencedSOPInstanceUID', '00081160 IS ReferencedFrameNumber', '00081199 SQ ReferencedSOPSequence',
  '00100010 PN PatientName', '00100020 LO PatientID', '00100030 DA PatientBirthDate', '00100040 CS PatientSex', '00181020 LO SoftwareVersions',
  '0020000d UI StudyInstanceUID', '0020000e UI SeriesInstanceUID', '00200010 SH StudyID', '00200011 IS SeriesNumber', '00200013 IS InstanceNumber',
  '0040a010 CS RelationshipType', '0040a040 CS ValueType', '0040a043 SQ ConceptNameCodeSequence', '0040a050 CS ContinuityOfContent', '0040a123 PN PersonName',
  '0040a124 UI UID', '0040a160 UT TextValue', '0040a168 SQ ConceptCodeSequence', '0040a300 SQ MeasuredValueSequence', '0040a30a DS NumericValue',
  '004008ea SQ MeasurementUnitsCodeSequence', '0040a372 SQ PerformedProcedureCodeSequence', '0040a375 SQ CurrentRequestedProcedureEvidenceSequence',
  '0040a491 CS CompletionFlag', '0040a493 CS VerificationFlag', '0040a496 CS PreliminaryFlag', '0040a504 SQ ContentTemplateSequence', '0040a730 SQ ContentSequence',
  '0040db00 CS TemplateIdentifier', '00700022 FL GraphicData', '00700023 CS GraphicType',
]) { const [tag, vr, key] = row.split(' '); dictionary[key] = [parseInt(tag, 16), vr]; }
function element(tag: number, vr: string, value: Buffer) {
  const long = ['OB', 'SQ', 'UT'].includes(vr), header = Buffer.alloc(long ? 12 : 8);
  if (!long && value.length > 65534) invalid();
  header.writeUInt16LE(tag >>> 16, 0); header.writeUInt16LE(tag & 65535, 2); header.write(vr, 4, 2, 'ascii');
  if (long) header.writeUInt32LE(value.length, 8); else header.writeUInt16LE(value.length, 6);
  return Buffer.concat([header, value]);
}
function encode(dataset: any): Buffer {
  return Buffer.concat(Object.keys(dataset).sort((a, b) => (dictionary[a]?.[0] || 0) - (dictionary[b]?.[0] || 0)).map(key => {
    const [tag, vr] = dictionary[key] || invalid(), value = dataset[key]; let bytes: Buffer;
    if (vr === 'SQ') bytes = Buffer.concat((Array.isArray(value) ? value : [value]).map(item => {
      const body = encode(item), head = Buffer.alloc(8); head.writeUInt32LE(0xe000fffe); head.writeUInt32LE(body.length, 4); return Buffer.concat([head, body]);
    }));
    else if (vr === 'FL') { bytes = Buffer.alloc(value.length * 4); value.forEach((n: number, i: number) => bytes.writeFloatLE(n, i * 4)); }
    else { bytes = Buffer.from(String(value), 'utf8'); if (bytes.length % 2) bytes = Buffer.concat([bytes, Buffer.from([vr === 'UI' ? 0 : 32])]); }
    return element(tag, vr, bytes);
  }));
}
export function srFile(dataset: any): Buffer {
  const text = (tag: number, vr: string, s: string) => { let b = Buffer.from(s); if (b.length % 2) b = Buffer.concat([b, Buffer.from([vr === 'UI' ? 0 : 32])]); return element(tag, vr, b); };
  const meta = Buffer.concat([element(0x00020001, 'OB', Buffer.from([0, 1])), text(0x00020002, 'UI', SR_CLASS),
    text(0x00020003, 'UI', dataset.SOPInstanceUID), text(0x00020010, 'UI', syntax), text(0x00020012, 'UI', srUid('KIN implementation v1')), text(0x00020013, 'SH', 'KIN_MANUAL_SR_1')]);
  const length = Buffer.alloc(4); length.writeUInt32LE(meta.length);
  const out = Buffer.concat([Buffer.alloc(128), Buffer.from('DICM'), element(0x00020000, 'UL', length), meta, encode(dataset)]);
  if (out.length > 524288) invalid(); return out;
}
