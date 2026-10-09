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
/** 'unknown': the stored Image Type is absent or its Value 1 is neither ORIGINAL nor DERIVED; the object stays listed. */
export type Derivation = { kind: 'original' } | { kind: 'derived'; sources: readonly SopRef[] } | { kind: 'unknown' } | { kind: 'not-image' };
export type FrameTiming = { source: 'frame-time'; frameTimeMs: number } | { source: 'frame-time-vector'; vectorMs: readonly number[] } | { source: 'none' };
/** Mammography facts as stored: the selected PS3.18 DICOM JSON header the server read, the raw source references it
 * extracted (null: read them from the header) and, optionally, another component's verdict, which is only recorded. */
export interface MammographyInput { header: DicomJson; declaredSources: readonly MgDeclaredSource[] | null; claimedClass: string | null }

export interface ManifestObjectInput extends SopRef {
  sopClassUid: string; transferSyntaxUid: string; imageType: readonly string[] | null;
  bytes: number; sha256: string; declaredFrameCount: number; frames: readonly FrameDigest[];
  provenance: Provenance; derivation: Derivation; mammography: MammographyInput | null; timing: FrameTiming | null;
}
export interface ManifestObject extends Omit<ManifestObjectInput, 'mammography'> {
  mammography: MammographyResult | null;
  format: ObjectFormat; family: SopFamily; decoder: string | null; timingVerified: boolean | null;
  unsupported: 'UnknownObjectFormat' | 'UnknownTransferSyntax' | null;
}
export interface AssetPin { id: string; version: string; sha256: string }
/** referencedObjects: headers of objects outside this study that stored source references name, with the patient and
 * institution keys the server resolved them under; they are never listed or delivered, only used to judge a link. */
export interface ManifestInput {
  formatVersion: 1; studyUid: string; managingInstitution: string; patient: PatientLinkSnapshot; builtAt: string;
  expected: { series: number; objects: number };
  pages: readonly { cursor: string | null; next: string | null; objects: readonly ManifestObjectInput[] }[];
  decoderCatalog: Readonly<Record<string, { version: string; sha256: string }>>;
  viewer: AssetPin;
  referencedObjects: readonly { header: DicomJson; patientKey: string; institutionKey: string }[];
}
export interface ImageManifest {
  formatVersion: 1; studyUid: string; managingInstitution: string; patient: PatientLinkSnapshot; builtAt: string;
  classificationRule: typeof MG_RULE_VERSION;
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

// ---------------------------------------------------------------------------------------------------------------
// D735 mammography classification (shared contract with E-MG, rule.md + rule-cases.json, schema D735-1). The class is
// read from the stored header only; a caller's label is recorded, never used. "verified" means this contract's header
// evidence is met, not diagnostic fitness, decoder or display correctness, or a preserved acquisition.

export const MG_RULE_VERSION = 'D735-1' as const;
export type DicomJson = Readonly<Record<string, { vr?: string; Value?: readonly unknown[] }>>;
export type MgClass = 'conventional-2d-presentation' | 'conventional-2d-processing' | 'device-synthetic-2d' | 'dbt-slices' | 'dbt-slab' |
  'projection' | 'partial-view' | 'unverified';
export interface MgDeclaredSource { path: string; sopClass: string | null; sop: string; frames: readonly number[] | null }
export interface MgSourceLink { path: string; sopClass: string | null; sop: string; frames: readonly number[] | null; status: 'verified' | 'rejected' | 'unresolved'; reason: string }
export interface MammographyResult {
  rule: typeof MG_RULE_VERSION; class: MgClass; baseClass: MgClass; status: 'verified' | 'unverified'; basis: string;
  partial: 'yes' | 'no' | 'unknown' | 'conflict'; presentation: 'presentation' | 'processing' | null;
  representation: 'slices' | 'slab' | 'mip-slab' | 'minip-slab' | 'unspecified' | null;
  fullViewAutoMatch: boolean; sourceClassEligible: boolean; laterality: string | null; view: string | null; biopsy: string | null;
  declaredSourceCount: number; rawReferenceRetained: boolean; links: readonly MgSourceLink[];
  sourceLinkStatus: 'verified' | 'rejected' | 'unresolved' | 'none' | 'not-applicable'; sourceAccepted: boolean; sourceLinks: string;
  claim: { class: string; agrees: boolean } | null;
}
const MG_P = '1.2.840.10008.5.1.4.1.1.1.2', MG_R = '1.2.840.10008.5.1.4.1.1.1.2.1', BTO = '1.2.840.10008.5.1.4.1.1.13.1.3';
const SOURCE_CLASSES: readonly MgClass[] = freeze(['dbt-slices', 'dbt-slab', 'projection']);
const GENERATED_V3: readonly string[] = freeze(['TOMOSYNTHESIS', 'TOMO_SCOUT', 'PREFIRE', 'POSTFIRE', 'POSTBIOPSY', 'POSTMARKER']);
const SLAB_PAIRS: readonly string[] = freeze(['NONE|MAX_IP', 'MAXIMUM|MAX_IP', 'NONE|MIN_IP', 'MAXIMUM|TOMOSYNTHESIS', 'MEAN|TOMOSYNTHESIS']);
/** Free text never confirms a kind; these words only stop a plain 2D from being called conventional. */
const LEGACY_HINT = /\bc-?view\b|synthetic|synthesi[sz]ed|\bv-?preview\b|intelligent\s*2d|\bs-?view\b|insight\s*2d|generated\s*2d|2d\s*generated/i;
/** View Code Sequence scheme|code -> view (CID 4014 terms seen in the stored sets). Unknown codes are no view. */
const VIEW_CODES: Readonly<Record<string, string>> = freeze(Object.fromEntries([
  ['CC', ['SCT|399162004', 'SRT|R-10242', 'SNM3|R-10242']], ['MLO', ['SCT|399368009', 'SRT|R-10226', 'SNM3|R-10226']],
  ['ML', ['SCT|399260004', 'SRT|R-10224', 'SNM3|R-10224']], ['LM', ['SCT|399352003', 'SRT|R-10228', 'SNM3|R-10228']],
  ['SPECIMEN', ['SCT|127457009', 'SRT|G-8310', 'SNM3|G-8310']],
].flatMap(([view, codes]) => (codes as string[]).map(code => [code, view as string]))));

class Unverified extends Error { constructor(readonly reason: string) { super(reason); } }
const fail = (reason: string): never => { throw new Unverified(reason); };
const has = (d: DicomJson, tag: string) => !!d && Object.prototype.hasOwnProperty.call(d, tag);
/** null: tag absent; []: present without a value. */
const valuesOf = (d: DicomJson, tag: string): readonly unknown[] | null => !has(d, tag) ? null : Array.isArray(d[tag]?.Value) ? d[tag].Value : [];
const text = (x: unknown) => typeof x === 'string' ? x.trim() : typeof x === 'number' && Number.isFinite(x) ? String(x) : x === null || x === undefined ? '' : null;
const strings = (d: DicomJson, tag: string): string[] | null => {
  const v = valuesOf(d, tag);
  return v === null ? null : v.map(x => { const t = text(x); return t === null ? fail('malformed-' + tag) : t; });
};
const first = (d: DicomJson, tag: string): string | null => { const v = strings(d, tag); return v && v.length && v[0] !== '' ? v[0] : null; };
const itemsOf = (d: DicomJson, tag: string): DicomJson[] | null => {
  const v = valuesOf(d, tag);
  if (v === null) return null;
  return v.map(x => x && typeof x === 'object' && !Array.isArray(x) ? x as DicomJson : fail('malformed-' + tag));
};
const numbers = (d: DicomJson, tag: string): number[] | null => {
  const v = valuesOf(d, tag);
  return v === null ? null : v.map(x => typeof x === 'number' ? x : typeof x === 'string' && x.trim() ? Number(x) : NaN);
};
/** Optional trailing empty values beyond Value 4 compare as absent; inner empty values keep their position. */
const typeKey = (t: readonly string[]) => { const out = [...t]; while (out.length > 4 && out[out.length - 1] === '') out.pop(); return out.join('\\'); };
const tol = (d: number) => Math.max(0.05, 0.01 * d);

interface Facts { laterality: string | null; view: string | null; modifier: boolean; partial: MammographyResult['partial']; partialCodes: string[]; btoCodeMissing: boolean }
function laterality(h: DicomJson, frames: DicomJson[]): { value: string | null; conflict: boolean } {
  const seen = new Set<string>();
  for (const tag of ['00200062', '00200060']) { const v = first(h, tag); if (v) seen.add(v.toUpperCase()); }
  for (const f of frames) for (const a of itemsOf(f, '00209071') ?? []) { const v = first(a, '00209072'); if (v) seen.add(v.toUpperCase()); }
  return { value: seen.size === 1 ? [...seen][0] : null, conflict: seen.size > 1 };
}
function facts(h: DicomJson, sop: string, frames: DicomJson[]): Facts & { lateralityConflict: boolean; viewConflict: boolean } {
  const lat = laterality(h, frames);
  const codeItem = (itemsOf(h, '00540220') ?? [])[0] ?? null;
  const codeView = codeItem ? VIEW_CODES[`${(first(codeItem, '00080102') ?? '').toUpperCase()}|${first(codeItem, '00080100') ?? ''}`] ?? null : null;
  const position = first(h, '00185101')?.toUpperCase() ?? null;
  const viewConflict = !!(codeView && position && codeView !== position);
  const view = codeItem ? codeView : position;
  const modifier = !!codeItem && (itemsOf(codeItem, '00540222') ?? []).length > 0;
  const flag = first(h, '00281350')?.toUpperCase() ?? null, codes = itemsOf(h, '00281352') ?? [], description = first(h, '00281351');
  let partial: MammographyResult['partial'];
  if (flag !== null && flag !== 'YES' && flag !== 'NO') partial = 'conflict';
  else if (codes.length > 2) partial = 'conflict';
  else if (flag === 'NO' && (codes.length || description)) partial = 'conflict';
  else if (flag === 'YES' || codes.length || description) partial = modifier ? 'conflict' : 'yes';
  else partial = flag === 'NO' ? 'no' : 'unknown';
  const partialCodes = codes.map(c => `${(first(c, '00080102') ?? '').toUpperCase()}|${first(c, '00080100') ?? ''}`).sort();
  return { laterality: lat.value, lateralityConflict: lat.conflict, view, viewConflict, modifier, partial, partialCodes,
    btoCodeMissing: sop === BTO && flag === 'YES' && codes.length === 0 };
}
const hologic = (h: DicomJson) => ['HOLOGIC', 'HOLOGIC, INC.'].includes((first(h, '00080070') ?? '').toUpperCase()) &&
  (first(h, '00081090') ?? '').toUpperCase() === 'SELENIA DIMENSIONS';
const software = (h: DicomJson, versions: readonly string[]) => (strings(h, '00181020') ?? []).some(s => versions.includes(s));

/** G: stored geometry of every frame, positions projected on the plane normal, regular spacing (rule.md G). */
function geometry(shared: DicomJson, perFrame: DicomJson[], dimension: DicomJson[] | null): { t: number; d: number } {
  const macro = (f: DicomJson, tag: string) => (itemsOf(f, tag) ?? itemsOf(shared, tag) ?? [])[0] ?? null;
  const rows = perFrame.map((f, i) => {
    const pm = macro(f, '00289110'), pos = macro(f, '00209113'), ori = macro(f, '00209116');
    const t = pm ? (numbers(pm, '00180050') ?? [])[0] : undefined;
    const p = pos ? numbers(pos, '00200032') : null, o = ori ? numbers(ori, '00200037') : null;
    if (!(Number.isFinite(t) && t > 0)) fail('geometry-thickness');
    if (!p || p.length !== 3 || !p.every(Number.isFinite)) fail('geometry-position');
    if (!o || o.length !== 6 || !o.every(Number.isFinite)) fail('geometry-orientation');
    const spacing = pm ? numbers(pm, '00180088') : null;
    const content = (itemsOf(f, '00209111') ?? [])[0] ?? null;
    return { i, t, p, o, spacing: spacing && spacing.length ? Math.abs(spacing[0]) : null, index: content ? numbers(content, '00209157') : null };
  });
  const [r0, r1, r2, c0, c1, c2] = rows[0].o;
  const norm = (a: number, b: number, c: number) => Math.hypot(a, b, c);
  if (Math.abs(norm(r0, r1, r2) - 1) > 1e-3 || Math.abs(norm(c0, c1, c2) - 1) > 1e-3 || Math.abs(r0 * c0 + r1 * c1 + r2 * c2) > 1e-3) fail('geometry-orientation');
  if (rows.some(r => r.o.some((x, k) => Math.abs(x - rows[0].o[k]) > 1e-3))) fail('geometry-orientation');
  const n = [r1 * c2 - r2 * c1, r2 * c0 - r0 * c2, r0 * c1 - r1 * c0];
  const z = rows.map(r => ({ i: r.i, z: r.p[0] * n[0] + r.p[1] * n[1] + r.p[2] * n[2], index: r.index }));
  const sorted = [...z].sort((a, b) => a.z - b.z), steps = sorted.slice(1).map((x, k) => x.z - sorted[k].z);
  const median = [...steps].sort((a, b) => a - b)[Math.floor((steps.length - 1) / 2)];
  if (!(median > 0) || steps.some(s => Math.abs(s - median) > tol(median))) fail('geometry-spacing');
  const t = rows[0].t;
  if (rows.some(r => Math.abs(r.t - t) > tol(median))) fail('geometry-thickness');
  if (rows.some(r => r.spacing !== null && Math.abs(r.spacing - median) > tol(median))) fail('geometry-spacing-tag');
  // A declared dimension on Image Position must order the same frames the positions do.
  const k = (dimension ?? []).findIndex(item => (strings(item, '00209165') ?? []).map(x => x.toUpperCase()).includes('00200032'));
  if (k >= 0) {
    const byIndex = z.map(x => ({ z: x.z, index: x.index && Number.isFinite(x.index[k]) ? x.index[k] : fail('geometry-dimension') }))
      .sort((a, b) => a.index - b.index);
    for (let j = 1; j < byIndex.length; j++) {
      const same = byIndex[j].index === byIndex[j - 1].index, dz = byIndex[j].z - byIndex[j - 1].z;
      if (same || Math.sign(dz) !== Math.sign(byIndex[1].z - byIndex[0].z) || Math.abs(dz) <= tol(median) / 2) fail('geometry-dimension');
    }
  }
  return { t, d: median };
}

type Base = { base: MgClass; basis: string; representation: MammographyResult['representation']; biopsy: string | null };
function classify2d(h: DicomJson, sop: string): Base {
  const nf = numbers(h, '00280008');
  if (nf !== null && !(nf.length === 1 && nf[0] === 1)) fail('frame-count');
  if (has(h, '52009229') || has(h, '52009230')) fail('functional-groups-outside-iod');
  const type = strings(h, '00080008');
  if (!type) fail('image-type-absent');
  if (first(h, '00080068')?.toUpperCase() !== (sop === MG_P ? 'FOR PRESENTATION' : 'FOR PROCESSING')) fail('presentation-intent');
  if (!['ORIGINAL', 'DERIVED'].includes(type[0])) fail('image-type-value1');
  if (!['PRIMARY', 'SECONDARY'].includes(type[1] ?? '')) fail('image-type-value2');
  const v3 = type[2] ?? null, v4 = type[3] ?? null, extension = type.slice(4).some(x => x !== '');
  const plainV4 = v4 === null || v4 === '' || v4 === 'NONE';
  const conventional = sop === MG_P ? 'conventional-2d-presentation' as const : 'conventional-2d-processing' as const;
  if (!extension && (v3 === null || v3 === '') && plainV4) {
    if (['0008103E', '00181030', '00082111'].some(tag => LEGACY_HINT.test(first(h, tag) ?? ''))) fail('possible-legacy-generated-2d');
    return { base: conventional, basis: v3 === null ? 'digital-mammography-legacy-null-v3' : 'digital-mammography', representation: null, biopsy: null };
  }
  if (!extension && v4 === 'GENERATED_2D' && GENERATED_V3.includes(v3)) {
    return { base: 'device-synthetic-2d', basis: 'digital-mammography', representation: null, biopsy: v3 === 'TOMOSYNTHESIS' ? null : v3 };
  }
  if (!extension && v3 === 'TOMO_PROJ' && plainV4) return { base: 'projection', basis: 'digital-mammography', representation: null, biopsy: null };
  if (extension || !(plainV4 || v4 === 'GENERATED_2D')) fail('unmapped-image-type-extension');
  return fail('image-type-unsupported');
}

function classifyBto(h: DicomJson): Base {
  const nf = valuesOf(h, '00280008');
  if (!nf || !nf.length) fail('frame-count-absent');
  const n = numbers(h, '00280008')[0];
  if (!Number.isInteger(n) || n < 1 || n > 2000) fail('frame-count-range');
  const sharedItems = itemsOf(h, '52009229') ?? [], perFrame = itemsOf(h, '52009230');
  if (sharedItems.length > 1) fail('shared-functional-groups');
  const shared = sharedItems[0] ?? {};
  if (!perFrame || perFrame.length !== n) fail('per-frame-count');
  if (has(shared, '00189504')) fail('shared-frame-type');
  for (const tag of Object.keys(shared)) if (perFrame.some(f => has(f, tag))) fail('shared-per-frame-duplicate');
  const type = strings(h, '00080008');
  if (!type) fail('image-type-absent');
  const [v1, v2, v3, v4] = [type[0], type[1] ?? '', type[2] ?? '', type[3] ?? ''];
  if (!['ORIGINAL', 'DERIVED'].includes(v1) || v2 !== 'PRIMARY' || !v3 || !v4) fail('image-type-profile');
  const key = typeKey(type), vp = first(h, '00089206'), technique = first(h, '00089207');
  for (const f of perFrame) {
    const ft = itemsOf(f, '00189504') ?? [];
    if (ft.length !== 1 || !has(ft[0], '00089007')) fail('frame-type-missing');
    // Every frame says what the object says: origin, purpose, flavor, derived pixel contrast and any later value.
    if (typeKey(strings(ft[0], '00089007')) !== key) fail('frame-type-mismatch');
    if (first(ft[0], '00089206') !== vp || vp === null) fail('volumetric-summary-conflict');
    if (first(ft[0], '00089207') !== technique || technique === null) fail('technique-summary-conflict');
  }
  if (type.some((x, i) => x === 'GENERATED_2D' && i !== 3) || (v3 === 'VOLUME' && v4 === 'GENERATED_2D')) fail('image-type-profile');
  if (v1 === 'ORIGINAL' && (v4 !== 'NONE' || technique !== 'NONE')) fail('original-requires-none');
  if (!['VOLUME', 'SAMPLED'].includes(vp)) fail('volumetric-unsupported');
  if (v4 === 'GENERATED_2D') {
    // R1 supports the observed Hologic Selenia Dimensions Intelligent 2D profile only; other devices stay unverified
    // as a support boundary, not as a DICOM violation (DC-01).
    if (n === 1 && key === 'DERIVED\\PRIMARY\\TOMOSYNTHESIS\\GENERATED_2D' && hologic(h) && software(h, ['AWS:1.9.1.8']) && vp === 'VOLUME' && technique === 'MAX_IP')
      return { base: 'device-synthetic-2d', basis: 'hologic-selenia-dimensions-bto-generated-2d', representation: null, biopsy: null };
    return fail('unsupported-device-profile');
  }
  if (v3 === 'TOMO_PROJ' && v4 === 'NONE') return { base: 'projection', basis: 'breast-tomosynthesis-projection', representation: null, biopsy: null };
  if (!['TOMOSYNTHESIS', 'VOLUME'].includes(v3) || n < 2) fail('image-type-unsupported');
  const g = geometry(shared, perFrame, itemsOf(h, '00209222'));
  const close = (a: number, b: number) => Math.abs(a - b) <= tol(g.d);
  if (v4 === 'NONE' && g.t <= 3 && close(g.t, g.d) && ['TOMOSYNTHESIS', 'NONE'].includes(technique))
    return { base: 'dbt-slices', basis: 'thin-slice-geometry', representation: 'slices', biopsy: null };
  if (v4 === 'NONE' && hologic(h) && software(h, ['AWS:1.8.3.63', 'AWS:1.9.1.8']) && Math.abs(g.t - 1) <= 0.05 && Math.abs(g.d - 1) <= 0.05 &&
      vp === 'VOLUME' && technique === 'MAX_IP')
    return { base: 'dbt-slices', basis: 'hologic-selenia-1mm-slices', representation: 'slices', biopsy: null };
  if (g.t > 3 && g.t + tol(g.d) >= g.d && SLAB_PAIRS.includes(`${v4}|${technique}`))
    return { base: 'dbt-slab', basis: 'thick-aggregation-and-geometry', representation: technique === 'MAX_IP' ? 'mip-slab' : technique === 'MIN_IP' ? 'minip-slab' : 'slab', biopsy: null };
  return fail('slice-or-slab-evidence');
}

interface Classified { sop: string; studyUid: string; sopClass: string; frameCount: number | null; result: Omit<MammographyResult,
  'declaredSourceCount' | 'rawReferenceRetained' | 'links' | 'sourceLinkStatus' | 'sourceAccepted' | 'sourceLinks' | 'claim'>; facts: Facts }
/** The header-only verdict (rule.md T, table rows 0-8, H, G/S/A, P). Source links are judged separately. */
export function classifyMammography(headerInput: unknown): Classified {
  if (!headerInput || typeof headerInput !== 'object' || Array.isArray(headerInput)) refuse('MammographyHeaderInvalid');
  const h = headerInput as DicomJson;
  const sop = first(h, '00080016') ?? '', sopInstance = first(h, '00080018') ?? '', studyUid = first(h, '0020000D') ?? '';
  const frames = [...(itemsOf(h, '52009229') ?? []), ...(itemsOf(h, '52009230') ?? [])];
  let f: ReturnType<typeof facts>;
  try { f = facts(h, sop, frames); } catch (e) { if (!(e instanceof Unverified)) throw e; f = { laterality: null, lateralityConflict: true, view: null, viewConflict: true, modifier: false, partial: 'conflict', partialCodes: [], btoCodeMissing: false }; }
  const presentationOfSop = sop === MG_P ? 'presentation' as const : sop === MG_R ? 'processing' as const : null;
  let base: Base = null, reason: string = null;
  try {
    if (![MG_P, MG_R, BTO].includes(sop)) fail('unsupported-sop');
    for (const uid of [sop, sopInstance, studyUid, first(h, '0020000E') ?? '']) if (uid.length > 64 || !/^[0-9]+(?:\.[0-9]+)+$/.test(uid)) fail('identity-invalid');
    if (first(h, '00080060')?.toUpperCase() !== 'MG') fail('modality-not-mg');
    base = sop === BTO ? classifyBto(h) : classify2d(h, sop);
    if (f.lateralityConflict) fail('laterality-conflict');
    if (f.viewConflict) fail('view-conflict');
    if (f.partial === 'conflict') fail('partial-conflict');
    if (f.btoCodeMissing) fail('partial-code-missing');
  } catch (e) {
    if (!(e instanceof Unverified)) throw e;
    base = null; reason = e.reason;
  }
  let type: string[] = [];
  try { type = strings(h, '00080008') ?? []; } catch (e) { if (!(e instanceof Unverified)) throw e; }
  const cls: MgClass = base === null ? 'unverified' : f.partial === 'yes' ? 'partial-view' : base.base;
  const baseClass: MgClass = base === null ? 'unverified' : base.base;
  const presentation = base === null ? presentationOfSop
    : ['dbt-slices', 'dbt-slab'].includes(base.base) ? null : sop === BTO ? 'presentation' as const : presentationOfSop;
  const representation = base !== null ? base.representation : sop === BTO && type[3] !== 'GENERATED_2D' ? 'unspecified' as const : null;
  const fullViewAutoMatch = base !== null && cls === base.base && ['conventional-2d-presentation', 'device-synthetic-2d', 'dbt-slices', 'dbt-slab'].includes(cls) &&
    f.partial === 'no' && presentation !== 'processing' && ['R', 'L'].includes(f.laterality) && ['CC', 'MLO'].includes(f.view) && !f.modifier && !base.biopsy;
  const sourceClassEligible = base !== null && SOURCE_CLASSES.includes(base.base);
  let nf: number | null = null;
  try { const v = numbers(h, '00280008'); nf = v && v.length && Number.isInteger(v[0]) ? v[0] : sop === BTO ? null : 1; } catch { nf = null; }
  return { sop: sopInstance, studyUid, sopClass: sop, frameCount: nf, facts: f,
    result: { rule: MG_RULE_VERSION, class: cls, baseClass, status: base === null ? 'unverified' : 'verified', basis: base === null ? reason : base.basis,
      partial: f.partial, presentation, representation, fullViewAutoMatch, sourceClassEligible, laterality: f.laterality, view: f.view,
      biopsy: base?.biopsy ?? null } };
}

/** Raw source references as the device stored them: Source Image Sequence at the top level and inside the Derivation
 * Image macro of the shared and per-frame groups. Kept with their path, class and frames whatever their status. */
function extractSources(h: DicomJson): MgDeclaredSource[] {
  const out: MgDeclaredSource[] = [];
  const read = (items: DicomJson[], path: string) => items.forEach((r, i) => out.push({ path: `${path}SourceImageSequence[${i}]/`,
    sopClass: first(r, '00081150'), sop: first(r, '00081155') ?? '', frames: numbers(r, '00081160') }));
  read(itemsOf(h, '00082112') ?? [], '');
  for (const [tag, name] of [['52009229', 'SharedFunctionalGroupsSequence'], ['52009230', 'PerFrameFunctionalGroupsSequence']]) {
    (itemsOf(h, tag) ?? []).forEach((g, gi) => (itemsOf(g, '00089124') ?? []).forEach((dv, di) =>
      read(itemsOf(dv, '00082112') ?? [], `${name}[${gi}]/DerivationImageSequence[${di}]/`)));
  }
  return out;
}
function declared(value: unknown, h: DicomJson): MgDeclaredSource[] {
  let fromHeader: MgDeclaredSource[];
  try { fromHeader = extractSources(h); } catch (e) { if (e instanceof Unverified) refuse('MammographyHeaderInvalid'); throw e; }
  if (value === null) return fromHeader;
  if (!Array.isArray(value)) refuse('MammographyHeaderMismatch');
  const list = value.map(x => {
    const v = object(x, ['path', 'sopClass', 'sop', 'frames']);
    if (v.frames !== null && (!Array.isArray(v.frames) || v.frames.some((n: unknown) => !Number.isInteger(n)))) refuse('MammographyHeaderMismatch');
    return { path: string(v.path), sopClass: v.sopClass === null ? null : string(v.sopClass), sop: string(v.sop), frames: v.frames === null ? null : [...v.frames] };
  });
  // The server's list may hold references outside the selected header (e.g. X-Ray 3D Acquisition); never fewer.
  if (fromHeader.some(r => !list.some(x => x.sop === r.sop))) refuse('MammographyHeaderMismatch');
  return list;
}

export interface MgStoreEntry { header: DicomJson; patientKey: string; institutionKey: string }
/** rule.md "synthetic 2D source reference contract" steps 1-5, per raw reference. */
function judgeSource(result: Classified, ref: MgDeclaredSource, store: ReadonlyMap<string, MgStoreEntry & { c: Classified }>, keys: { patientKey: string; institutionKey: string }):
  { status: MgSourceLink['status']; reason: string } {
  if (ref.sop === result.sop) return { status: 'rejected', reason: 'self-reference' };
  const target = store.get(ref.sop);
  if (!target) return { status: 'unresolved', reason: 'not-in-store' };
  if (target.patientKey !== keys.patientKey) return { status: 'rejected', reason: 'other-patient' };
  if (target.institutionKey !== keys.institutionKey) return { status: 'rejected', reason: 'other-institution' };
  if (target.c.studyUid !== result.studyUid) return { status: 'rejected', reason: 'other-study' };
  if (ref.sopClass !== null && ref.sopClass !== target.c.sopClass) return { status: 'rejected', reason: 'class-conflict' };
  if (ref.frames && ref.frames.some(n => target.c.frameCount === null || n < 1 || n > target.c.frameCount)) return { status: 'rejected', reason: 'frame-out-of-range' };
  // The stored header decides what the target is; no label makes a conventional or unverified object a source.
  if (target.c.result.status !== 'verified' || !SOURCE_CLASSES.includes(target.c.result.baseClass)) return { status: 'rejected', reason: 'target-not-tomosynthesis-data' };
  if (target.c.facts.modifier !== result.facts.modifier) return { status: 'rejected', reason: 'modifier-conflict' };
  if (!result.facts.laterality || !target.c.facts.laterality) return { status: 'unresolved', reason: 'laterality-unknown' };
  if (result.facts.laterality !== target.c.facts.laterality) return { status: 'rejected', reason: 'other-side' };
  if (!result.facts.view || !target.c.facts.view) return { status: 'unresolved', reason: 'view-unknown' };
  if (result.facts.view !== target.c.facts.view) return { status: 'rejected', reason: 'other-view' };
  const [a, b] = [result.facts, target.c.facts];
  if (a.partial === 'no' && b.partial === 'no') return { status: 'verified', reason: 'same-breast-view-full' };
  if (a.partial === 'yes' && b.partial === 'yes') return a.partialCodes.length && a.partialCodes.join(',') === b.partialCodes.join(',')
    ? { status: 'verified', reason: 'same-partial-region' } : { status: 'rejected', reason: 'other-partial-region' };
  if ((a.partial === 'yes' && b.partial === 'no') || (a.partial === 'no' && b.partial === 'yes')) return { status: 'rejected', reason: 'partial-scope-conflict' };
  return { status: 'unresolved', reason: 'partial-unknown' };
}
function mammographyResult(c: Classified, refs: MgDeclaredSource[], claimedClass: string | null, store: ReadonlyMap<string, MgStoreEntry & { c: Classified }>,
  keys: { patientKey: string; institutionKey: string }): MammographyResult {
  const synthetic = c.result.status === 'verified' && c.result.baseClass === 'device-synthetic-2d';
  const links: MgSourceLink[] = refs.map(r => ({ ...r, ...(synthetic ? judgeSource(c, r, store, keys)
    : { status: 'unresolved' as const, reason: store.has(r.sop) ? 'not-a-synthetic-result' : 'not-in-store' }) }));
  const sourceLinkStatus = !synthetic ? 'not-applicable' as const : !links.length ? 'none' as const
    : links.some(l => l.status === 'rejected') ? 'rejected' as const : links.some(l => l.status === 'unresolved') ? 'unresolved' as const : 'verified' as const;
  const sourceLinks = !links.length ? 'none' : links.every(l => l.reason === 'not-in-store') ? 'unresolved-not-in-input-store'
    : synthetic ? sourceLinkStatus : 'not-verified';
  return { ...c.result, declaredSourceCount: refs.length, rawReferenceRetained: refs.length > 0, links, sourceLinkStatus,
    sourceAccepted: sourceLinkStatus === 'verified', sourceLinks, claim: claimedClass === null ? null : { class: claimedClass, agrees: claimedClass === c.result.class } };
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

type Pending = { c: Classified; header: DicomJson; refs: MgDeclaredSource[]; claimedClass: string | null };
const NO_STORE: ReadonlyMap<string, MgStoreEntry & { c: Classified }> = new Map();
function entry(value: unknown, studyUid: string, keys: { patientKey: string; institutionKey: string }): [ManifestObject, Pending | null] {
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
  else if (derivationKind === 'unknown') { object(v.derivation, ['kind']); derivation = { kind: 'unknown' }; }
  else if (derivationKind === 'derived') {
    const d = object(v.derivation, ['kind', 'sources']);
    if (!Array.isArray(d.sources)) refuse('DerivationMismatch');
    const sources = d.sources.map(sopRef);
    if (new Set(sources.map(s => s.sopInstanceUid)).size !== sources.length || sources.some(s => s.sopInstanceUid === ref.sopInstanceUid)) refuse('DerivedSourceMismatch');
    derivation = { kind: 'derived', sources };
  } else return refuse('DerivationMismatch');
  if (format !== 'unsupported') {
    // ImageType value 1 is the object's own statement of ORIGINAL/DERIVED; the manifest may not relabel it. An image
    // whose Image Type is absent or names neither stays listed as 'unknown' (its classification says unverified).
    const pixel = PIXEL_FORMATS.includes(format);
    const value1 = imageType?.[0]?.trim();
    if (pixel && derivation.kind !== (value1 === 'ORIGINAL' ? 'original' : value1 === 'DERIVED' ? 'derived' : 'unknown')) refuse('DerivationMismatch');
    if (!pixel && (imageType !== null || derivation.kind !== 'not-image')) refuse('DerivationMismatch');
  }
  const source = provenance(v.provenance, format);
  // Mammography objects carry their stored header; the class is read from it (D735), never taken from a label.
  let pending: Pending = null;
  if (v.mammography === null) {
    if (family === 'mammography-2d' || family === 'breast-tomosynthesis') refuse('MammographyHeaderRequired');
  } else {
    const m = object(v.mammography, ['header', 'declaredSources', 'claimedClass']);
    const c = classifyMammography(m.header), header = m.header as DicomJson;
    const raw = header['00080008'] === undefined ? null : Array.isArray(header['00080008'].Value) ? header['00080008'].Value : [];
    if (c.sop !== ref.sopInstanceUid || c.sopClass !== sopClassUid || c.studyUid !== ref.studyUid ||
        (header['0020000E']?.Value?.[0] ?? null) !== ref.seriesUid || JSON.stringify(raw) !== JSON.stringify(imageType)) refuse('MammographyHeaderMismatch');
    pending = { c, header, refs: declared(m.declaredSources, header), claimedClass: m.claimedClass === null ? null : string(m.claimedClass) };
  }
  if (v.timing !== null && !PIXEL_FORMATS.includes(format)) refuse('InvalidFrameTiming');
  const time = timing(v.timing, declaredFrameCount);
  const mammography = pending ? mammographyResult(pending.c, pending.refs, pending.claimedClass, NO_STORE, keys) : null;
  return [{ ...ref, sopClassUid, transferSyntaxUid, imageType, bytes, sha256: digest, declaredFrameCount, frames, provenance: source, derivation,
    mammography, timing: time.timing, format, family, decoder: unsupported ? null : decoder, timingVerified: time.verified, unsupported }, pending];
}

const built = new WeakSet<object>();
/** Consumers accept only a manifest this module built in-process; a copy or a deserialized lookalike is refused. */
export function verifiedManifest(input: ImageManifest): ImageManifest {
  if (!input || typeof input !== 'object' || !built.has(input)) refuse('ManifestRequired');
  return input;
}

export function buildImageManifest(input: ManifestInput): Readonly<ImageManifest> {
  const v = object(input, ['formatVersion', 'studyUid', 'managingInstitution', 'patient', 'builtAt', 'expected', 'pages', 'decoderCatalog', 'viewer', 'referencedObjects']);
  if (v.formatVersion !== 1) refuse('UnknownManifestFormat');
  const studyUid = dicomUid(v.studyUid), managingInstitution = string(v.managingInstitution), patient = patientLink(v.patient), builtAt = utc(v.builtAt);
  const expected = object(v.expected, ['series', 'objects']);
  integer(expected.series, 1); integer(expected.objects, 1);
  if (!Array.isArray(v.pages) || !v.pages.length) refuse('ManifestPageIncomplete');
  // Pages must chain cursor to cursor and end with no next page; a short or reordered listing is incomplete, never "the study".
  let cursor: string | null = null;
  const keys = { patientKey: patient.linkId, institutionKey: managingInstitution };
  const bySop = new Map<string, { object: ManifestObject; canonical: string; pending: Pending | null }>();
  for (const page of v.pages) {
    const p = object(page, ['cursor', 'next', 'objects']);
    if (p.cursor !== cursor || !Array.isArray(p.objects)) refuse('ManifestPageIncomplete');
    if (p.next !== null) string(p.next);
    for (const raw of p.objects) {
      const [item, pending] = entry(raw, studyUid, keys), canonical = JSON.stringify(item), seen = bySop.get(item.sopInstanceUid);
      if (seen && seen.canonical !== canonical) refuse('DuplicateObjectConflict');
      if (!seen) bySop.set(item.sopInstanceUid, { object: item, canonical, pending });
    }
    cursor = p.next;
  }
  if (cursor !== null) refuse('ManifestPageIncomplete');
  // Source links are judged against the stored headers of this study's objects and the out-of-study objects the server
  // resolved for those references, each under the keys it was resolved with.
  const store = new Map<string, MgStoreEntry & { c: Classified }>();
  for (const x of bySop.values()) if (x.pending) store.set(x.pending.c.sop, { header: x.pending.header, ...keys, c: x.pending.c });
  if (!Array.isArray(v.referencedObjects)) refuse('MammographyHeaderInvalid');
  for (const raw of v.referencedObjects) {
    const r = object(raw, ['header', 'patientKey', 'institutionKey']), c = classifyMammography(r.header);
    if (!c.sop || store.has(c.sop) || bySop.has(c.sop)) refuse('DuplicateObjectConflict');
    store.set(c.sop, { header: r.header, patientKey: string(r.patientKey), institutionKey: string(r.institutionKey), c });
  }
  const objects = [...bySop.values()].map(x => x.pending ? { ...x.object, mammography: mammographyResult(x.pending.c, x.pending.refs, x.pending.claimedClass, store, keys) } : x.object)
    .sort((a, b) => a.seriesUid < b.seriesUid ? -1 : a.seriesUid > b.seriesUid ? 1 : a.sopInstanceUid < b.sopInstanceUid ? -1 : a.sopInstanceUid > b.sopInstanceUid ? 1 : 0);
  if (objects.length !== expected.objects || new Set(objects.map(o => o.seriesUid)).size !== expected.series) refuse('ManifestPageIncomplete');
  const bySopUid = new Map(objects.map(o => [o.sopInstanceUid, o]));
  for (const o of objects) {
    if (o.derivation.kind !== 'derived') continue;
    for (const s of o.derivation.sources) {
      const target = bySopUid.get(s.sopInstanceUid);
      // A declared source that is held must be the same object it names; an absent one stays as the object declared it.
      if (target && (target.seriesUid !== s.seriesUid || target.studyUid !== s.studyUid)) refuse('DerivedSourceMismatch');
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
  // The classification contract version and every object's classification and source-link state are content: a new
  // rule or a changed link judgement is a new manifest version, never an earlier verdict reused.
  const classificationRule = MG_RULE_VERSION;
  const digest = createHash('sha256').update(JSON.stringify({ formatVersion: 1, classificationRule, studyUid, managingInstitution, patient, objects, decoders, viewer })).digest('hex');
  const manifest = freeze({ formatVersion: 1 as const, studyUid, managingInstitution, patient, builtAt, classificationRule, objects, decoders, viewer, sha256: digest });
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
