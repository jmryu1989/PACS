import { createHash } from 'node:crypto';
import { patientLink, PatientLinkSnapshot } from '../emr-contract/access-event';
import type { RecordKind } from '../emr-contract/classification';
import { choice, freeze, integer, object, refuse, sha256, string, utc } from '../emr-contract/validation';

/**
 * EMR-E R1: the fixed object manifest of one study. The server builds it from what the store actually holds
 * (R2 reads Orthanc and the receipt tables); this module only checks that the facts are complete and consistent.
 * Nothing here sends bytes or records a delivery. Unknown formats stay listed but are never deliverable, so a
 * study with one odd object still opens normally while that object is refused by name.
 */

export type ObjectFormat = 'image' | 'presentation-state' | 'structured-report' | 'segmentation' | 'encapsulated-pdf' | 'unsupported';
export type SopFamily = 'general' | 'mammography-2d' | 'breast-tomosynthesis' | 'xa';
const PIXEL_FORMATS: readonly ObjectFormat[] = ['image', 'segmentation'];

const sop = (format: ObjectFormat, family: SopFamily = 'general'): { format: ObjectFormat; family: SopFamily } => ({ format, family });
const STORAGE = '1.2.840.10008.5.1.4.1.1.';
/** PS3.4 storage SOP classes the reading workspace displays. A class missing here is listed as unsupported, not guessed. */
export const SOP_CLASSES: Readonly<Record<string, { format: ObjectFormat; family: SopFamily }>> = freeze(Object.fromEntries(([
  ['1', sop('image')], ['1.1', sop('image')], ['1.1.1', sop('image')],
  ['1.2', sop('image', 'mammography-2d')], ['1.2.1', sop('image', 'mammography-2d')],
  ['1.3', sop('image')], ['1.3.1', sop('image')],
  ['2', sop('image')], ['2.1', sop('image')], ['2.2', sop('image')],
  ['3.1', sop('image')], ['4', sop('image')], ['4.1', sop('image')], ['4.3', sop('image')], ['4.4', sop('image')],
  ['6.1', sop('image')], ['6.2', sop('image')],
  ['7', sop('image')], ['7.1', sop('image')], ['7.2', sop('image')], ['7.3', sop('image')], ['7.4', sop('image')],
  ['12.1', sop('image', 'xa')], ['12.1.1', sop('image', 'xa')], ['12.2', sop('image')], ['12.2.1', sop('image')],
  ['13.1.1', sop('image')], ['13.1.2', sop('image')],
  ['13.1.3', sop('image', 'breast-tomosynthesis')],
  ['13.1.4', sop('image', 'mammography-2d')], ['13.1.5', sop('image', 'mammography-2d')],
  ['20', sop('image')], ['30', sop('image')],
  ['77.1.1', sop('image')], ['77.1.2', sop('image')], ['77.1.4', sop('image')], ['77.1.5.1', sop('image')], ['77.1.6', sop('image')],
  ['128', sop('image')], ['128.1', sop('image')], ['130', sop('image')], ['481.1', sop('image')],
  ['11.1', sop('presentation-state')], ['11.2', sop('presentation-state')], ['11.3', sop('presentation-state')], ['11.4', sop('presentation-state')],
  ['66.4', sop('segmentation')],
  ...['11', '22', '33', '34', '35', '40', '50', '59', '65', '67', '68', '69', '70', '71', '72', '73', '74', '75', '76']
    .map(suffix => [`88.${suffix}`, sop('structured-report')] as const),
  ['104.1', sop('encapsulated-pdf')],
] as [string, { format: ObjectFormat; family: SopFamily }][]).map(([suffix, value]) => [STORAGE + suffix, value])));

/** Decoder the viewer needs for a transfer syntax; the deployed asset version comes from the server's asset catalog. */
export const TRANSFER_SYNTAX_DECODER: Readonly<Record<string, string>> = freeze({
  '1.2.840.10008.1.2': 'native', '1.2.840.10008.1.2.1': 'native', '1.2.840.10008.1.2.2': 'native',
  '1.2.840.10008.1.2.1.99': 'deflate',
  '1.2.840.10008.1.2.4.50': 'jpeg-baseline', '1.2.840.10008.1.2.4.51': 'jpeg-baseline',
  '1.2.840.10008.1.2.4.57': 'jpeg-lossless', '1.2.840.10008.1.2.4.70': 'jpeg-lossless',
  '1.2.840.10008.1.2.4.80': 'jpeg-ls', '1.2.840.10008.1.2.4.81': 'jpeg-ls',
  '1.2.840.10008.1.2.4.90': 'jpeg-2000', '1.2.840.10008.1.2.4.91': 'jpeg-2000',
  '1.2.840.10008.1.2.4.201': 'htj2k', '1.2.840.10008.1.2.4.202': 'htj2k', '1.2.840.10008.1.2.4.203': 'htj2k',
  '1.2.840.10008.1.2.5': 'rle',
});

export interface SopRef { studyUid: string; seriesUid: string; sopInstanceUid: string }
export interface FrameDigest { number: number; bytes: number; sha256: string }
/** Every object came from somewhere. External producers keep their own system, receipt and signature evidence;
 * this product never adds a clinician signature to them (EMR-A 'source-evidence'). */
export type Provenance =
  | { kind: 'device'; receiptEventId: string | null }
  | { kind: 'product-authored'; recordId: string }
  | { kind: 'external'; system: string; receiptEventId: string; signatureEvidence: { status: 'present'; sha256: string } | { status: 'absent' } };
export type Derivation = { kind: 'original' } | { kind: 'derived'; sources: readonly SopRef[] } | { kind: 'not-image' };
export type MammographyKind = 'dbt' | 'generated-2d' | 'conventional-2d' | 'unverified';
/** frameTypes: the distinct Frame Type (0008,9007) values across the object's frames (null when the IOD has none);
 * volumetricProperties: (0008,9206) as stored. Both come from the stored headers, never from the classifier. */
export interface MammographyRoleInput {
  kind: MammographyKind; laterality: 'L' | 'R' | 'B' | null; view: string | null;
  frameTypes: readonly (readonly string[])[] | null; volumetricProperties: string | null;
}
export interface MammographyRole extends MammographyRoleInput { dbtRepresentation: 'slices' | 'slab' | 'unspecified' | null }
export type FrameTiming = { source: 'frame-time'; frameTimeMs: number } | { source: 'frame-time-vector'; vectorMs: readonly number[] } | { source: 'none' };

export interface ManifestObjectInput extends SopRef {
  sopClassUid: string; transferSyntaxUid: string; imageType: readonly string[] | null;
  bytes: number; sha256: string; declaredFrameCount: number; frames: readonly FrameDigest[];
  provenance: Provenance; derivation: Derivation; mammography: MammographyRoleInput | null; timing: FrameTiming | null;
}
export interface ManifestObject extends Omit<ManifestObjectInput, 'mammography'> {
  mammography: MammographyRole | null;
  format: ObjectFormat; family: SopFamily; decoder: string | null; timingVerified: boolean | null;
  unsupported: 'UnknownObjectFormat' | 'UnknownTransferSyntax' | null;
}
export interface AssetPin { id: string; version: string; sha256: string }
export interface ManifestInput {
  formatVersion: 1; studyUid: string; managingInstitution: string; patient: PatientLinkSnapshot; builtAt: string;
  expected: { series: number; objects: number };
  pages: readonly { cursor: string | null; next: string | null; objects: readonly ManifestObjectInput[] }[];
  decoderCatalog: Readonly<Record<string, { version: string; sha256: string }>>;
  viewer: AssetPin;
}
export interface ImageManifest {
  formatVersion: 1; studyUid: string; managingInstitution: string; patient: PatientLinkSnapshot; builtAt: string;
  objects: readonly ManifestObject[]; decoders: readonly AssetPin[]; viewer: AssetPin; sha256: string;
}

/** Same grammar the product already accepts for study UIDs (connect/authz): digits and dots, at most 64 characters. */
export function dicomUid(value: unknown): string {
  const s = string(value);
  if (s.length > 64 || !/^[0-9]+(?:\.[0-9]+)+$/.test(s)) refuse('InvalidDicomUid');
  return s;
}
function sopRef(value: unknown): SopRef {
  const v = object(value, ['studyUid', 'seriesUid', 'sopInstanceUid']);
  return { studyUid: dicomUid(v.studyUid), seriesUid: dicomUid(v.seriesUid), sopInstanceUid: dicomUid(v.sopInstanceUid) };
}
const hasKeys = (value: unknown, keys: readonly string[]) => !!value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(k => Object.prototype.hasOwnProperty.call(value, k));

function provenance(value: unknown, format: ObjectFormat): Provenance {
  const kind = (value as any)?.kind;
  if (kind === 'external') {
    // A received object without its source system, receipt and signature-evidence status is refused, never defaulted.
    if (!hasKeys(value, ['kind', 'system', 'receiptEventId', 'signatureEvidence'])) refuse('ExternalSourceRequired');
    const v = value as any;
    if (typeof v.system !== 'string' || !v.system.trim() || typeof v.receiptEventId !== 'string' || !v.receiptEventId.trim()) refuse('ExternalSourceRequired');
    const evidence = v.signatureEvidence?.status === 'present'
      ? (object(v.signatureEvidence, ['status', 'sha256']), { status: 'present' as const, sha256: sha256(v.signatureEvidence.sha256) })
      : v.signatureEvidence?.status === 'absent' ? (object(v.signatureEvidence, ['status']), { status: 'absent' as const })
      : refuse('ExternalSourceRequired');
    return { kind, system: string(v.system), receiptEventId: string(v.receiptEventId), signatureEvidence: evidence };
  }
  if (kind === 'product-authored') {
    const v = object(value, ['kind', 'recordId']);
    // Only the manual SR is authored by this product; any other object claiming it would hide its real source.
    if (format !== 'structured-report') refuse('ProvenanceMismatch');
    return { kind, recordId: string(v.recordId) };
  }
  if (kind === 'device') {
    const v = object(value, ['kind', 'receiptEventId']);
    // Device objects are images/presentation states stored through the institution's own acquisition path.
    // SR, SEG and PDF come from an external producer (EMR-A 'external-sr-seg'/'pdf') and must say which.
    if (!['image', 'presentation-state', 'unsupported'].includes(format)) refuse('ExternalSourceRequired');
    return { kind, receiptEventId: v.receiptEventId === null ? null : string(v.receiptEventId) };
  }
  return refuse('ObjectSourceRequired');
}

/** Image Type Value 3 terms of a tomosynthesis-derived 2D view (PS3.3 C.8.11.7; the biopsy terms as E-MG reads them). */
const GENERATED_2D_VALUE3: readonly string[] = freeze(['TOMOSYNTHESIS', 'PREFIRE', 'POSTFIRE', 'POSTBIOPSY', 'POSTMARKER']);

function mammography(value: unknown, entry: { family: SopFamily; declaredFrameCount: number; imageType: readonly string[] | null }): MammographyRole | null {
  const mg = entry.family === 'mammography-2d' || entry.family === 'breast-tomosynthesis';
  if (!mg) { if (value !== null) refuse('MammographyRoleUnexpected'); return null; }
  if (value === null) refuse('MammographyRoleRequired');
  const v = object(value, ['kind', 'laterality', 'view', 'frameTypes', 'volumetricProperties']);
  const kind = choice(v.kind, ['dbt', 'generated-2d', 'conventional-2d', 'unverified'] as const);
  const laterality = v.laterality === null ? null : choice(v.laterality, ['L', 'R', 'B'] as const);
  const view = v.view === null ? null : string(v.view);
  if (view !== null && !/^[A-Z]{1,8}$/.test(view)) refuse('MammographyKindMismatch');
  let frameTypes: string[][] = null;
  if (v.frameTypes !== null) {
    if (!Array.isArray(v.frameTypes) || v.frameTypes.some((t: unknown) => !Array.isArray(t))) refuse('MammographyKindMismatch');
    frameTypes = v.frameTypes.map((t: unknown[]) => t.map(x => string(x, true)));
  }
  const volumetricProperties = v.volumetricProperties === null ? null : string(v.volumetricProperties);
  const type = entry.imageType ?? [], value3 = type[2] ?? '', value4 = type[3] ?? '';
  const oneFrame = entry.declaredFrameCount === 1;
  // The kind is the E-MG model's verdict; here only what the stored headers contradict is refused (PS3.3 A.55.3,
  // C.8.11.7, C.8.21.6). A device synthetic 2D may be stored in the Breast Tomosynthesis IOD: then it is one frame
  // whose Image Type and every Frame Type say TOMOSYNTHESIS (or a biopsy term) \ GENERATED_2D. A multi-frame object is
  // never a generated 2D, and a tomosynthesis volume carries no GENERATED_2D anywhere.
  if (entry.family === 'breast-tomosynthesis') {
    const ft = frameTypes ?? [];
    if (kind === 'generated-2d' && !(oneFrame && value4 === 'GENERATED_2D' && GENERATED_2D_VALUE3.includes(value3) &&
        ft.length === 1 && ft[0][3] === 'GENERATED_2D')) refuse('MammographyKindMismatch');
    if (kind === 'dbt' && (type.includes('GENERATED_2D') || ft.length > 1 || ft.some(t => t.includes('GENERATED_2D')))) refuse('MammographyKindMismatch');
    if (kind === 'conventional-2d') refuse('MammographyKindMismatch');
  } else {
    if (kind === 'dbt') refuse('MammographyKindMismatch');
    if (kind === 'generated-2d' && !(oneFrame && value4 === 'GENERATED_2D' && GENERATED_2D_VALUE3.includes(value3))) refuse('MammographyKindMismatch');
    // Value 1 DERIVED describes pixel processing (CMMD DERIVED\PRIMARY); only Value 3/4 would mark something else.
    if (kind === 'conventional-2d' && !(oneFrame && !value3 && !value4)) refuse('MammographyKindMismatch');
  }
  // Volumetric Properties decides what DBT frames are (C.8.21.1.1.3 notes): VOLUME = regularly sampled slices,
  // SAMPLED = slabs/MIPs. Anything else is kept as stored and reported as unspecified.
  const dbtRepresentation = kind !== 'dbt' ? null : volumetricProperties === 'VOLUME' ? 'slices' as const
    : volumetricProperties === 'SAMPLED' ? 'slab' as const : 'unspecified' as const;
  return { kind, laterality, view, frameTypes, volumetricProperties, dbtRepresentation };
}

function timing(value: unknown, frames: number): { timing: FrameTiming | null; verified: boolean | null } {
  if (value === null) return { timing: null, verified: null };
  const source = (value as any)?.source;
  if (source === 'none') { object(value, ['source']); return { timing: { source }, verified: false }; }
  if (source === 'frame-time') {
    const v = object(value, ['source', 'frameTimeMs']);
    if (typeof v.frameTimeMs !== 'number' || !Number.isFinite(v.frameTimeMs)) refuse('InvalidFrameTiming');
    return { timing: { source, frameTimeMs: v.frameTimeMs }, verified: v.frameTimeMs > 0 && frames >= 2 };
  }
  if (source === 'frame-time-vector') {
    const v = object(value, ['source', 'vectorMs']);
    if (!Array.isArray(v.vectorMs) || v.vectorMs.some(x => typeof x !== 'number' || !Number.isFinite(x))) refuse('InvalidFrameTiming');
    // The stored vector is kept as stored; whether it describes these frames is reported, not repaired (E-XA plays it).
    const verified = v.vectorMs.length === frames && frames >= 2 && v.vectorMs[0] === 0 && v.vectorMs.slice(1).every(x => x > 0);
    return { timing: { source, vectorMs: [...v.vectorMs] }, verified };
  }
  return refuse('InvalidFrameTiming');
}

function entry(value: unknown, studyUid: string): ManifestObject {
  const v = object(value, ['studyUid', 'seriesUid', 'sopInstanceUid', 'sopClassUid', 'transferSyntaxUid', 'imageType', 'bytes', 'sha256',
    'declaredFrameCount', 'frames', 'provenance', 'derivation', 'mammography', 'timing']);
  const ref = { studyUid: dicomUid(v.studyUid), seriesUid: dicomUid(v.seriesUid), sopInstanceUid: dicomUid(v.sopInstanceUid) };
  if (ref.studyUid !== studyUid) refuse('ObjectStudyMismatch');
  const sopClassUid = dicomUid(v.sopClassUid), transferSyntaxUid = dicomUid(v.transferSyntaxUid);
  const known = Object.prototype.hasOwnProperty.call(SOP_CLASSES, sopClassUid) ? SOP_CLASSES[sopClassUid] : null;
  const format: ObjectFormat = known ? known.format : 'unsupported', family: SopFamily = known ? known.family : 'general';
  const decoder = Object.prototype.hasOwnProperty.call(TRANSFER_SYNTAX_DECODER, transferSyntaxUid) ? TRANSFER_SYNTAX_DECODER[transferSyntaxUid] : null;
  const unsupported = !known ? 'UnknownObjectFormat' as const : !decoder ? 'UnknownTransferSyntax' as const : null;
  const bytes = integer(v.bytes, 1), digest = sha256(v.sha256), declaredFrameCount = integer(v.declaredFrameCount);
  if (!Array.isArray(v.frames)) refuse('FrameSetIncomplete');
  const frames = v.frames.map((f: unknown) => {
    const x = object(f, ['number', 'bytes', 'sha256']);
    return { number: integer(x.number, 1), bytes: integer(x.bytes, 1), sha256: sha256(x.sha256) };
  }).sort((a, b) => a.number - b.number);
  if (new Set(frames.map(f => f.number)).size !== frames.length) refuse('FrameSetConflict');
  if (PIXEL_FORMATS.includes(format)) {
    // Every stored frame, first to last, by number. The last frame missing is the classic silent truncation.
    if (declaredFrameCount < 1 || frames.length !== declaredFrameCount || frames.some((f, i) => f.number !== i + 1)) refuse('FrameSetIncomplete');
  } else if (format !== 'unsupported' && (declaredFrameCount !== 0 || frames.length)) refuse('FrameSetIncomplete');
  if (frames.reduce((sum, f) => sum + f.bytes, 0) > bytes) refuse('FrameBytesExceedObject');
  let imageType: string[] | null = null;
  if (v.imageType !== null) {
    if (!Array.isArray(v.imageType) || v.imageType.length < 1) refuse('DerivationMismatch');
    imageType = v.imageType.map((x: unknown) => string(x, true));
  }
  const derivationKind = (v.derivation as any)?.kind;
  let derivation: Derivation;
  if (derivationKind === 'original') { object(v.derivation, ['kind']); derivation = { kind: 'original' }; }
  else if (derivationKind === 'not-image') { object(v.derivation, ['kind']); derivation = { kind: 'not-image' }; }
  else if (derivationKind === 'derived') {
    const d = object(v.derivation, ['kind', 'sources']);
    if (!Array.isArray(d.sources)) refuse('DerivationMismatch');
    const sources = d.sources.map(sopRef);
    if (new Set(sources.map(s => s.sopInstanceUid)).size !== sources.length || sources.some(s => s.sopInstanceUid === ref.sopInstanceUid)) refuse('DerivedSourceMismatch');
    derivation = { kind: 'derived', sources };
  } else return refuse('DerivationMismatch');
  if (format !== 'unsupported') {
    // ImageType value 1 is the object's own statement of ORIGINAL/DERIVED; the manifest may not relabel it.
    const pixel = PIXEL_FORMATS.includes(format);
    if (pixel !== (imageType !== null)) refuse('DerivationMismatch');
    if (pixel && derivation.kind !== (imageType[0] === 'ORIGINAL' ? 'original' : imageType[0] === 'DERIVED' ? 'derived' : '-')) refuse('DerivationMismatch');
    if (!pixel && derivation.kind !== 'not-image') refuse('DerivationMismatch');
  }
  const source = provenance(v.provenance, format);
  const role = mammography(v.mammography, { family, declaredFrameCount, imageType });
  if (v.timing !== null && !PIXEL_FORMATS.includes(format)) refuse('InvalidFrameTiming');
  const time = timing(v.timing, declaredFrameCount);
  return { ...ref, sopClassUid, transferSyntaxUid, imageType, bytes, sha256: digest, declaredFrameCount, frames, provenance: source, derivation,
    mammography: role, timing: time.timing, format, family, decoder: unsupported ? null : decoder, timingVerified: time.verified, unsupported };
}

const built = new WeakSet<object>();
/** Consumers accept only a manifest this module built in-process; a copy or a deserialized lookalike is refused. */
export function verifiedManifest(input: ImageManifest): ImageManifest {
  if (!input || typeof input !== 'object' || !built.has(input)) refuse('ManifestRequired');
  return input;
}

export function buildImageManifest(input: ManifestInput): Readonly<ImageManifest> {
  const v = object(input, ['formatVersion', 'studyUid', 'managingInstitution', 'patient', 'builtAt', 'expected', 'pages', 'decoderCatalog', 'viewer']);
  if (v.formatVersion !== 1) refuse('UnknownManifestFormat');
  const studyUid = dicomUid(v.studyUid), managingInstitution = string(v.managingInstitution), patient = patientLink(v.patient), builtAt = utc(v.builtAt);
  const expected = object(v.expected, ['series', 'objects']);
  integer(expected.series, 1); integer(expected.objects, 1);
  if (!Array.isArray(v.pages) || !v.pages.length) refuse('ManifestPageIncomplete');
  // Pages must chain cursor to cursor and end with no next page; a short or reordered listing is incomplete, never "the study".
  let cursor: string | null = null;
  const bySop = new Map<string, { object: ManifestObject; canonical: string }>();
  for (const page of v.pages) {
    const p = object(page, ['cursor', 'next', 'objects']);
    if (p.cursor !== cursor || !Array.isArray(p.objects)) refuse('ManifestPageIncomplete');
    if (p.next !== null) string(p.next);
    for (const raw of p.objects) {
      const item = entry(raw, studyUid), canonical = JSON.stringify(item), seen = bySop.get(item.sopInstanceUid);
      if (seen && seen.canonical !== canonical) refuse('DuplicateObjectConflict');
      if (!seen) bySop.set(item.sopInstanceUid, { object: item, canonical });
    }
    cursor = p.next;
  }
  if (cursor !== null) refuse('ManifestPageIncomplete');
  const objects = [...bySop.values()].map(x => x.object)
    .sort((a, b) => a.seriesUid < b.seriesUid ? -1 : a.seriesUid > b.seriesUid ? 1 : a.sopInstanceUid < b.sopInstanceUid ? -1 : a.sopInstanceUid > b.sopInstanceUid ? 1 : 0);
  if (objects.length !== expected.objects || new Set(objects.map(o => o.seriesUid)).size !== expected.series) refuse('ManifestPageIncomplete');
  const bySopUid = new Map(objects.map(o => [o.sopInstanceUid, o]));
  for (const o of objects) {
    if (o.derivation.kind !== 'derived') continue;
    for (const s of o.derivation.sources) {
      const target = bySopUid.get(s.sopInstanceUid);
      // A declared source that is held must be the same object it names; an absent one stays as the object declared it.
      if (target && (target.seriesUid !== s.seriesUid || target.studyUid !== s.studyUid)) refuse('DerivedSourceMismatch');
      // A generated 2D comes from tomosynthesis data of the same breast (the DBT volume or its stored projections,
      // which E-MG may leave unverified), never from another 2D view or a non-breast object.
      if (target && o.mammography?.kind === 'generated-2d' && (!target.mammography || ['conventional-2d', 'generated-2d'].includes(target.mammography.kind) ||
          (o.mammography.laterality && target.mammography.laterality && o.mammography.laterality !== target.mammography.laterality))) refuse('DerivedSourceMismatch');
    }
  }
  const catalog = v.decoderCatalog;
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) refuse('DecoderAssetMissing');
  const needed = [...new Set(objects.filter(o => PIXEL_FORMATS.includes(o.format) && o.decoder).map(o => o.decoder))].sort();
  const decoders = needed.map(id => {
    if (!Object.prototype.hasOwnProperty.call(catalog, id)) refuse('DecoderAssetMissing');
    const pin = object(catalog[id], ['version', 'sha256']);
    return { id, version: string(pin.version), sha256: sha256(pin.sha256) };
  });
  const viewerPin = object(v.viewer, ['id', 'version', 'sha256']);
  const viewer = { id: string(viewerPin.id), version: string(viewerPin.version), sha256: sha256(viewerPin.sha256) };
  // builtAt is when, not what: the digest names the content so an unchanged study keeps its fixed version.
  const digest = createHash('sha256').update(JSON.stringify({ formatVersion: 1, studyUid, managingInstitution, patient, objects, decoders, viewer })).digest('hex');
  const manifest = freeze({ formatVersion: 1 as const, studyUid, managingInstitution, patient, builtAt, objects, decoders, viewer, sha256: digest });
  built.add(manifest);
  return manifest;
}

export function manifestObject(manifest: ImageManifest, sopInstanceUid: string): ManifestObject | null {
  return verifiedManifest(manifest).objects.find(o => o.sopInstanceUid === sopInstanceUid) ?? null;
}

/** EMR-A record kind of a stored object (DicomInstance discriminator); unsupported objects stay unclassified for R2/G. */
export function recordKindOf(item: ManifestObject): RecordKind | null {
  switch (item.format) {
    case 'image': case 'presentation-state': return 'image';
    case 'structured-report': return item.provenance.kind === 'product-authored' ? 'manual-sr' : 'external-sr-seg';
    case 'segmentation': return 'external-sr-seg';
    case 'encapsulated-pdf': return 'pdf';
    default: return null;
  }
}
