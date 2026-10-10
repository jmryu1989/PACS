import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { identity } from '../emr-contract/access-event';
import type { AccessAction, CauseKind, DurableAccessReceipt, EvidenceFact, ImmutableIdentity } from '../emr-contract/access-event';
import type { RecordKind } from '../emr-contract/classification';
import { choice, freeze, integer, object, refuse, sha256, string, utc } from '../emr-contract/validation';
import { dicomUid, ImageManifest, ManifestObject, recordKindOf, verifiedManifest } from './manifest';

/**
 * EMR-E R1 pure contracts: which image requests exist, what a prepared response covers, when bytes count as
 * delivered, the processing/transfer basis behind a provision, offline-bundle readiness and display records.
 * None of this sends a byte, stores an event or decides a role; C authorizes, B stores, R2 streams. Authorization
 * (the 204 of authz/dicom), durable preparation, the transfer outcome, the display report and the explicit ACK are
 * separate observations and never stand in for one another.
 */

// ---------------------------------------------------------------------------------------------------------------
// Image request grammar: the only shapes the image boundary serves. Everything else is refused before any read.

export type ImageRequestKind = 'study-query' | 'series-query' | 'instance-query' | 'metadata' | 'study-retrieve' | 'series-retrieve' |
  'object' | 'frames' | 'rendered' | 'frame-rendered' | 'bulk';
export interface ImageRequest {
  method: 'GET' | 'HEAD'; kind: ImageRequestKind; studyUid: string; seriesUid: string | null; sopInstanceUid: string | null;
  frames: readonly number[] | null; bulkTag: string | null; query: Readonly<Record<string, string>>;
}
/** Orthanc's own REST roots. Reaching any of them through the image boundary would bypass the manifest and the
 * per-object scope (e.g. /instances/{id}/file returns the whole original with patient tags). */
export const DIRECT_ORTHANC_ROOTS: readonly string[] = freeze(['instances', 'series', 'studies', 'patients', 'tools', 'system', 'statistics',
  'plugins', 'modalities', 'peers', 'jobs', 'changes', 'exports', 'app', 'wado', 'queries', 'storage-commitment', 'transfers', 'worklists', 'ui']);
const QUERY_KEYS: Readonly<Partial<Record<ImageRequestKind, readonly string[]>>> = freeze({
  'study-query': ['StudyInstanceUID', '0020000D', 'includefield'], 'series-query': ['includefield'], 'instance-query': ['includefield'],
  rendered: ['viewport', 'window'], 'frame-rendered': ['viewport', 'window'],
});
const QUERY_VALUE: Readonly<Record<string, RegExp>> = freeze({
  includefield: /^(?:[0-9A-Fa-f]{8}|[A-Za-z][A-Za-z0-9]{0,63})(?:,(?:[0-9A-Fa-f]{8}|[A-Za-z][A-Za-z0-9]{0,63}))*$/,
  viewport: /^[1-9][0-9]{0,3},[1-9][0-9]{0,3}$/,
  window: /^-?[0-9]{1,6}(?:\.[0-9]{1,6})?,[0-9]{1,6}(?:\.[0-9]{1,6})?(?:,(?:linear|linear-exact|sigmoid))?$/,
});
const positive = (s: string) => /^[1-9][0-9]{0,8}$/.test(s) ? Number(s) : refuse('ImagePathRefused');
const parsed = new WeakSet<object>();

export function parseImageRequest(method: unknown, target: unknown): Readonly<ImageRequest> {
  const m = string(method);
  if (m !== 'GET' && m !== 'HEAD') refuse('ImageMethodRefused');
  const t = string(target);
  // Encoded separators, dot segments, doubled or trailing slashes and absolute forms are how a proxy path escapes
  // its prefix. UIDs never need them, so the path is matched literally and anything else is refused.
  if (t.length > 4096 || !t.startsWith('/') || /[\s\\#\x00-\x1f\x7f]/.test(t)) refuse('ImagePathRefused');
  const mark = t.indexOf('?'), path = mark < 0 ? t : t.slice(0, mark), rawQuery = mark < 0 ? '' : t.slice(mark + 1);
  if (path.includes('%') || path.includes('//') || path.endsWith('/') || path.split('/').some(s => s === '.' || s === '..')) refuse('ImagePathRefused');
  const s = path.split('/').slice(1);
  if (s[0] !== 'dicom-web') refuse(DIRECT_ORTHANC_ROOTS.includes(s[0]) ? 'DirectOrthancPathRefused' : 'ImagePathRefused');
  const p = s.slice(1);
  let kind: ImageRequestKind, studyUid: string = null, seriesUid: string = null, sopInstanceUid: string = null;
  let frames: number[] = null, bulkTag: string = null;
  const uidAt = (i: number) => { try { return dicomUid(p[i]); } catch { return refuse('ImagePathRefused'); } };
  if (p[0] !== 'studies') refuse(p[0] === 'servers' ? 'DirectOrthancPathRefused' : 'ImagePathRefused');
  if (p.length === 1) kind = 'study-query';
  else {
    studyUid = uidAt(1);
    const rest = p.slice(2);
    if (!rest.length) kind = 'study-retrieve';
    else if (rest.length === 1 && rest[0] === 'series') kind = 'series-query';
    else if (rest.length === 1 && rest[0] === 'instances') kind = 'instance-query';
    else if (rest.length === 1 && rest[0] === 'metadata') kind = 'metadata';
    else if (rest[0] === 'series' && rest.length >= 2) {
      seriesUid = uidAt(3);
      const r = rest.slice(2);
      if (!r.length) kind = 'series-retrieve';
      else if (r.length === 1 && r[0] === 'metadata') kind = 'metadata';
      else if (r.length === 1 && r[0] === 'instances') kind = 'instance-query';
      else if (r[0] === 'instances' && r.length >= 2) {
        sopInstanceUid = uidAt(5);
        const x = r.slice(2);
        if (!x.length) kind = 'object';
        else if (x.length === 1 && x[0] === 'metadata') kind = 'metadata';
        else if (x.length === 1 && x[0] === 'rendered') kind = 'rendered';
        else if (x[0] === 'frames' && (x.length === 2 || (x.length === 3 && x[2] === 'rendered'))) {
          frames = x[1].split(',').map(positive);
          if (new Set(frames).size !== frames.length) refuse('ImagePathRefused');
          kind = x.length === 3 ? 'frame-rendered' : 'frames';
          if (kind === 'frame-rendered' && frames.length !== 1) refuse('ImagePathRefused');
        } else if (x[0] === 'bulk' && x.length >= 2 && x.slice(1).every((part, i) => i % 2 ? /^(?:0|[1-9][0-9]{0,5})$/.test(part) : /^[0-9a-f]{8}$/.test(part)) && x.length % 2 === 0) {
          kind = 'bulk'; bulkTag = x.slice(1).join('/');
        } else refuse('ImagePathRefused');
      } else refuse('ImagePathRefused');
    } else refuse('ImagePathRefused');
  }
  const query: Record<string, string> = {};
  if (rawQuery) {
    if (!/^[A-Za-z0-9_.,=&%\-]*$/.test(rawQuery)) refuse('ImageQueryRefused');
    const allowed = QUERY_KEYS[kind] ?? [];
    for (const pair of rawQuery.split('&')) {
      const eq = pair.indexOf('=');
      if (eq <= 0) refuse('ImageQueryRefused');
      let key: string, value: string;
      try { key = decodeURIComponent(pair.slice(0, eq)); value = decodeURIComponent(pair.slice(eq + 1)); } catch { return refuse('ImageQueryRefused'); }
      if (!allowed.includes(key) || Object.prototype.hasOwnProperty.call(query, key)) refuse('ImageQueryRefused');
      const rule = key === 'StudyInstanceUID' || key === '0020000D' ? /^[0-9]+(?:\.[0-9]+)+$/ : QUERY_VALUE[key];
      if (!value || value.length > 2048 || !rule.test(value)) refuse('ImageQueryRefused');
      query[key] = value;
    }
  }
  if (kind === 'study-query') {
    // A study query without exactly one study UID would enumerate the archive; the worklist API lists studies.
    const ids = ['StudyInstanceUID', '0020000D'].filter(k => Object.prototype.hasOwnProperty.call(query, k));
    if (ids.length !== 1) refuse('ImageQueryRefused');
    try { studyUid = dicomUid(query[ids[0]]); } catch { refuse('ImageQueryRefused'); }
  }
  const request = freeze({ method: m as 'GET' | 'HEAD', kind, studyUid, seriesUid, sopInstanceUid, frames, bulkTag, query });
  parsed.add(request);
  return request;
}

// ---------------------------------------------------------------------------------------------------------------
// Provision basis: who receives image data, under which basis. Normal reading inside the managing institution needs
// nothing beyond C's authorization; a processor needs the 제26조 document; a third party needs consent or a listed
// statutory exception and, in Part 1, is still never sent bytes (기관외 송부는 켜지 않는다).

export type ProvisionRelation = 'same-institution' | 'processor' | 'third-party-recipient';
/** Closed exceptions to patient consent for sending records to another provider (의료법 제21조의2). */
export const PROVISION_EXCEPTIONS = freeze({
  'medical:21-2.1-proviso': { law: '의료법', article: '제21조의2①단서', facts: ['patient-unconscious', 'emergency-patient', 'guardian-unavailable'] },
  'medical:21-2.2': { law: '의료법', article: '제21조의2②', facts: ['emergency-transfer'] },
} satisfies Record<string, { law: string; article: string; facts: readonly string[] }>);
/** 개인정보 보호법 제26조①1·2 and 시행령 제28조①1–5: the written terms a processing agreement must contain. */
export const PROCESSOR_DOCUMENT_ITEMS: readonly string[] = freeze(['purposeLimit', 'safeguards', 'purposeAndScope', 'subProcessingLimit',
  'accessRestriction', 'supervision', 'liability']);
/** Part 1 product scope: no image body leaves the managing institution's own system, whatever basis is recorded. */
export const PART1_THIRD_PARTY_DELIVERY = false;

export interface ProvisionScope { studyUids: readonly string[] | 'institution-studies'; recipient: string; purpose: string }
export type RecipientBasis =
  | { kind: 'patient-consent'; basisId: string; obtainedAt: string; expiresAt: string | null; revokedAt: string | null; scope: ProvisionScope }
  | { kind: 'statutory-exception'; basisId: string; clauseId: keyof typeof PROVISION_EXCEPTIONS; fact: string; recordedAt: string; revokedAt: string | null; scope: ProvisionScope };
export interface ProcessingAgreementFacts {
  agreementId: string; processor: string; validFrom: string; validTo: string | null; terminatedAt: string | null; scope: ProvisionScope;
  document: Readonly<Record<string, boolean>>; disclosure: { method: 'website' | 'premises' | 'publication' | 'contract-copy'; since: string } | null;
  subProcessors: readonly { name: string; consentedAt: string | null }[]; location: 'domestic' | 'overseas';
}
export interface ProvisionInput {
  relation: ProvisionRelation; at: string; managingInstitution: string; recipient: string | null; studyUid: string; purpose: string | null;
  basis: RecipientBasis | null; agreement: ProcessingAgreementFacts | null; auditBefore: { eventId: string } | null;
}
export interface ProvisionDecision {
  relation: ProvisionRelation; studyUid: string; managingInstitution: string; recipient: string | null; at: string;
  basisId: string | null; agreementId: string | null; auditBeforeEventId: string | null; deliverable: boolean; refusal: string | null;
}
const decisions = new WeakSet<object>();

function scope(value: unknown): ProvisionScope {
  const v = object(value, ['studyUids', 'recipient', 'purpose']);
  const studyUids = v.studyUids === 'institution-studies' ? 'institution-studies' as const
    : Array.isArray(v.studyUids) && v.studyUids.length ? v.studyUids.map(dicomUid) : refuse('ProvisionOutOfScope');
  return { studyUids, recipient: string(v.recipient), purpose: string(v.purpose) };
}
const covers = (s: ProvisionScope, studyUid: string, recipient: string, purpose: string) =>
  (s.studyUids === 'institution-studies' || s.studyUids.includes(studyUid)) && s.recipient === recipient && s.purpose === purpose;
const within = (at: string, from: string, to: string | null) => from <= at && (to === null || at < to);

export function checkProvisionBasis(input: ProvisionInput): Readonly<ProvisionDecision> {
  const v = object(input, ['relation', 'at', 'managingInstitution', 'recipient', 'studyUid', 'purpose', 'basis', 'agreement', 'auditBefore']);
  const relation = choice(v.relation, ['same-institution', 'processor', 'third-party-recipient'] as const);
  const at = utc(v.at), managingInstitution = string(v.managingInstitution), studyUid = dicomUid(v.studyUid);
  const done = (fields: Omit<ProvisionDecision, 'relation' | 'studyUid' | 'managingInstitution' | 'at'>) => {
    const d = freeze({ relation, studyUid, managingInstitution, at, ...fields });
    decisions.add(d);
    return d;
  };
  if (relation === 'same-institution') {
    // The reading workspace inside the managing institution: no consent prompt, no contract, no extra audit step.
    if (v.recipient !== null || v.basis !== null || v.agreement !== null || v.purpose !== null) refuse('ProvisionRelationMismatch');
    return done({ recipient: null, basisId: null, agreementId: null, auditBeforeEventId: v.auditBefore === null ? null : string(object(v.auditBefore, ['eventId']).eventId), deliverable: true, refusal: null });
  }
  const recipient = string(v.recipient), purpose = string(v.purpose);
  if (recipient === managingInstitution) refuse('ProvisionRelationMismatch');
  // 전송 전후 기록: the before-record exists before anything is opened; the after-record closes the delivery (R2).
  if (v.auditBefore === null) refuse('AuditBeforeRequired');
  const auditBeforeEventId = string(object(v.auditBefore, ['eventId']).eventId);
  if (relation === 'processor') {
    if (v.basis !== null) refuse('ProvisionRelationMismatch');
    if (v.agreement === null) refuse('ProcessingAgreementRequired');
    const a = object(v.agreement, ['agreementId', 'processor', 'validFrom', 'validTo', 'terminatedAt', 'scope', 'document', 'disclosure', 'subProcessors', 'location']);
    if (string(a.processor) !== recipient) refuse('ProvisionOutOfScope');
    if (a.terminatedAt !== null && utc(a.terminatedAt) <= at) refuse('AgreementTerminated');
    if (!within(at, utc(a.validFrom), a.validTo === null ? null : utc(a.validTo))) refuse('AgreementInactive');
    const doc = a.document;
    if (!doc || typeof doc !== 'object' || Array.isArray(doc) || Object.keys(doc).length !== PROCESSOR_DOCUMENT_ITEMS.length ||
        PROCESSOR_DOCUMENT_ITEMS.some(k => doc[k] !== true)) refuse('AgreementDocumentIncomplete');
    if (a.disclosure === null) refuse('ProcessorDisclosureMissing');
    const disclosure = object(a.disclosure, ['method', 'since']);
    choice(disclosure.method, ['website', 'premises', 'publication', 'contract-copy']);
    if (utc(disclosure.since) > at) refuse('ProcessorDisclosureMissing');
    if (!Array.isArray(a.subProcessors)) refuse('SubProcessingConsentMissing');
    for (const sp of a.subProcessors) {
      const x = object(sp, ['name', 'consentedAt']); string(x.name);
      if (x.consentedAt === null || utc(x.consentedAt) > at) refuse('SubProcessingConsentMissing');
    }
    // 제28조의8 overseas transfer and the unverified off-site annex (시설·장비 기준 별표) are not opened in Part 1.
    if (choice(a.location, ['domestic', 'overseas']) !== 'domestic') refuse('OverseasTransferNotEnabled');
    if (!covers(scope(a.scope), studyUid, recipient, purpose)) refuse('ProvisionOutOfScope');
    return done({ recipient, basisId: null, agreementId: string(a.agreementId), auditBeforeEventId, deliverable: true, refusal: null });
  }
  if (v.agreement !== null) refuse('ProvisionRelationMismatch');
  if (v.basis === null) refuse('ConsentOrExceptionRequired');
  const kind = (v.basis as any).kind;
  let basisId: string, from: string, until: string | null = null, revokedAt: string | null, s: ProvisionScope;
  if (kind === 'patient-consent') {
    const b = object(v.basis, ['kind', 'basisId', 'obtainedAt', 'expiresAt', 'revokedAt', 'scope']);
    basisId = string(b.basisId); from = utc(b.obtainedAt); until = b.expiresAt === null ? null : utc(b.expiresAt);
    revokedAt = b.revokedAt === null ? null : utc(b.revokedAt); s = scope(b.scope);
  } else if (kind === 'statutory-exception') {
    const b = object(v.basis, ['kind', 'basisId', 'clauseId', 'fact', 'recordedAt', 'revokedAt', 'scope']);
    if (!Object.prototype.hasOwnProperty.call(PROVISION_EXCEPTIONS, b.clauseId)) refuse('ConsentOrExceptionRequired');
    if (!(PROVISION_EXCEPTIONS[b.clauseId as keyof typeof PROVISION_EXCEPTIONS].facts as readonly string[]).includes(b.fact)) refuse('ConsentOrExceptionRequired');
    basisId = string(b.basisId); from = utc(b.recordedAt); revokedAt = b.revokedAt === null ? null : utc(b.revokedAt); s = scope(b.scope);
  } else return refuse('ConsentOrExceptionRequired');
  // A consent or exception names the studies it sends; it is never a standing institution-wide permission.
  if (s.studyUids === 'institution-studies') refuse('ProvisionOutOfScope');
  if (revokedAt !== null && revokedAt <= at) refuse('BasisRevoked');
  if (from > at) refuse('BasisNotYetValid');
  if (until !== null && until <= at) refuse('BasisExpired');
  if (!covers(s, studyUid, recipient, purpose)) refuse('ProvisionOutOfScope');
  return done({ recipient, basisId, agreementId: null, auditBeforeEventId, deliverable: PART1_THIRD_PARTY_DELIVERY,
    refusal: PART1_THIRD_PARTY_DELIVERY ? null : 'ExternalDeliveryNotEnabled' });
}

// ---------------------------------------------------------------------------------------------------------------
// Prepared delivery: the exact units one response may carry, bound to one manifest version, before the first byte.

/** displayable: the unit carries what a reader sees (pixels, a rendering, a document), not metadata or a header attribute. */
export interface DeliveryUnit {
  key: string; sopInstanceUid: string | null; part: 'object' | 'frame' | 'derived'; frame: number | null;
  expectedBytes: number | null; sha256: string | null; recordKind: RecordKind; displayable: boolean;
}
export interface OpeningRef { openingId: string; accountGeneration: number; sequence: number }
/** Who received the bytes: relation, acting institution, account generation and viewer opening. Bytes sent to one
 * receiver never complete a provision to another. */
export interface DeliveryReceiver {
  relation: ProvisionRelation; institution: string; accountGeneration: number; openingId: string | null; sequence: number | null;
}
export interface PreparedDelivery {
  formatVersion: 1; eventId: string; manifestSha256: string; studyUid: string; managingInstitution: string; request: ImageRequest;
  body: boolean; cause: CauseKind; relation: ProvisionRelation; opening: OpeningRef | null; receiver: DeliveryReceiver; preparedAt: string;
  units: readonly DeliveryUnit[]; excluded: readonly { sopInstanceUid: string; reason: string }[];
}
/** authorization: C's verdict for this request (study, acting institution, the caller's account generation).
 * opening: the viewer opening the request serves (null for a device or service load that serves no opening). */
export interface DeliveryContext {
  eventId: string; cause: CauseKind; at: string; authorization: { studyUid: string; institution: string; accountGeneration: number };
  provision: ProvisionDecision; opening: OpeningRef | null;
}
const prepared = new WeakSet<object>();
const deliverable = (o: ManifestObject) => o.unsupported === null;
const DISPLAYED_FORMATS: readonly string[] = freeze(['image', 'segmentation', 'encapsulated-pdf', 'structured-report']);
const objectUnit = (o: ManifestObject): DeliveryUnit => ({ key: `object:${o.sopInstanceUid}`, sopInstanceUid: o.sopInstanceUid, part: 'object', frame: null,
  expectedBytes: o.bytes, sha256: o.sha256, recordKind: recordKindOf(o), displayable: DISPLAYED_FORMATS.includes(o.format) });
const derivedUnit = (key: string, sopInstanceUid: string | null, frame: number | null, recordKind: RecordKind, displayable: boolean): DeliveryUnit =>
  ({ key: `derived:${key}`, sopInstanceUid, part: 'derived', frame, expectedBytes: null, sha256: null, recordKind, displayable });

export function prepareDelivery(manifestInput: ImageManifest, requestInput: ImageRequest, context: DeliveryContext): Readonly<PreparedDelivery> {
  const manifest = verifiedManifest(manifestInput);
  const c = object(context, ['eventId', 'cause', 'at', 'authorization', 'provision', 'opening']);
  const eventId = string(c.eventId), cause = choice(c.cause, ['user-view', 'background-fetch', 'service-job'] as const), preparedAt = utc(c.at);
  let opening: OpeningRef = null;
  if (c.opening !== null) {
    const o = object(c.opening, ['openingId', 'accountGeneration', 'sequence']);
    opening = { openingId: string(o.openingId), accountGeneration: integer(o.accountGeneration, 1), sequence: integer(o.sequence, 1) };
  }
  // Only a request the grammar parsed is served: a hand-built object cannot widen the scope the grammar allows.
  if (!requestInput || typeof requestInput !== 'object' || !parsed.has(requestInput)) refuse('ImageRequestRequired');
  const request = requestInput;
  if (!c.provision || !decisions.has(c.provision)) refuse('ProvisionDecisionRequired');
  const provision: ProvisionDecision = c.provision;
  if (provision.studyUid !== manifest.studyUid || provision.managingInstitution !== manifest.managingInstitution) refuse('ProvisionOutOfScope');
  // The basis is decided for this preparation; an earlier decision could predate a revocation or termination.
  if (provision.at !== preparedAt) refuse('ProvisionDecisionStale');
  if (!provision.deliverable) refuse(provision.refusal);
  // C's 204 names the study and the acting institution: the managing institution itself, or the processor it named.
  // A 204 for another study or another institution authorizes nothing here.
  const auth = object(c.authorization, ['studyUid', 'institution', 'accountGeneration']);
  const accountGeneration = integer(auth.accountGeneration, 1);
  const actor = provision.relation === 'processor' ? provision.recipient : manifest.managingInstitution;
  if (auth.studyUid !== manifest.studyUid || auth.institution !== actor) refuse('AuthorizationScopeMismatch');
  // An opening belongs to one account generation; a 204 of another generation does not serve it.
  if (opening !== null && opening.accountGeneration !== accountGeneration) refuse('AuthorizationScopeMismatch');
  const receiver: DeliveryReceiver = { relation: provision.relation, institution: actor, accountGeneration,
    openingId: opening?.openingId ?? null, sequence: opening?.sequence ?? null };
  if (request.studyUid !== manifest.studyUid) refuse('ScopeOutsideManifest');
  const inSeries = (uid: string) => manifest.objects.filter(o => o.seriesUid === uid);
  if (request.seriesUid !== null && !inSeries(request.seriesUid).length) refuse('ScopeOutsideManifest');
  let target: ManifestObject = null;
  if (request.sopInstanceUid !== null) {
    target = manifest.objects.find(o => o.sopInstanceUid === request.sopInstanceUid) ?? refuse('ScopeOutsideManifest');
    if (target.seriesUid !== request.seriesUid) refuse('ScopeOutsideManifest');
    if (!deliverable(target)) refuse(target.unsupported);
  }
  const units: DeliveryUnit[] = [], excluded: { sopInstanceUid: string; reason: string }[] = [];
  const pixel = (o: ManifestObject) => o.format === 'image' || o.format === 'segmentation';
  switch (request.kind) {
    case 'study-query': case 'series-query': case 'instance-query': case 'metadata':
      units.push(derivedUnit(`${request.kind}:${request.sopInstanceUid ?? request.seriesUid ?? request.studyUid}`, request.sopInstanceUid, null, 'study-metadata', false));
      break;
    case 'study-retrieve': case 'series-retrieve':
      for (const o of request.kind === 'study-retrieve' ? manifest.objects : inSeries(request.seriesUid)) {
        if (deliverable(o)) units.push(objectUnit(o)); else excluded.push({ sopInstanceUid: o.sopInstanceUid, reason: o.unsupported });
      }
      if (!units.length) refuse('ScopeOutsideManifest');
      break;
    case 'object': units.push(objectUnit(target)); break;
    case 'frames': case 'frame-rendered':
      if (!pixel(target)) refuse('ScopeOutsideManifest');
      for (const n of request.frames) {
        const f = target.frames.find(x => x.number === n) ?? refuse('FrameOutOfManifest');
        units.push(request.kind === 'frames'
          ? { key: `frame:${target.sopInstanceUid}#${n}`, sopInstanceUid: target.sopInstanceUid, part: 'frame', frame: n, expectedBytes: f.bytes, sha256: f.sha256,
              recordKind: 'image', displayable: true }
          : derivedUnit(`rendered:${target.sopInstanceUid}#${n}`, target.sopInstanceUid, n, 'thumbnail', true));
      }
      break;
    case 'rendered':
      if (!pixel(target) && target.format !== 'encapsulated-pdf') refuse('ScopeOutsideManifest');
      units.push(derivedUnit(`rendered:${target.sopInstanceUid}`, target.sopInstanceUid, null, target.format === 'encapsulated-pdf' ? 'pdf' : 'thumbnail', true));
      break;
    case 'bulk':
      // Only the Pixel Data of an image or the Encapsulated Document of a PDF is something a reader sees;
      // any other bulk attribute (PixelSpacing, LUTs, overlays) is header data.
      units.push(derivedUnit(`bulk:${target.sopInstanceUid}/${request.bulkTag}`, target.sopInstanceUid, null, recordKindOf(target),
        (request.bulkTag === '7fe00010' && pixel(target)) || (request.bulkTag === '00420011' && target.format === 'encapsulated-pdf')));
      break;
    default: refuse('ImagePathRefused');
  }
  const result = freeze({ formatVersion: 1 as const, eventId, manifestSha256: manifest.sha256, studyUid: manifest.studyUid, managingInstitution: manifest.managingInstitution,
    request, body: request.method === 'GET', cause, relation: provision.relation, opening, receiver, preparedAt, units, excluded });
  prepared.add(result);
  return result;
}

// ---------------------------------------------------------------------------------------------------------------
// Transfer judgement: only bytes the server wrote inside a response that ended normally, after a durable receipt,
// count, and a manifest-bound unit is complete only where those bytes were also verified against the fixed hash. A
// 204, a prepared event, an aborted or unknown response, an unverified range, a range sent to another receiver or
// bytes whose source hash differs from the manifest never make a unit complete. Socket "finish" is the server's end of
// the transfer, not a person seeing it.

/** verifiedBy: the bytes of this range were written from one store read (readId) of the whole unit whose SHA-256 the
 * stream computed; null when the stream did not verify what it wrote. */
export type RangeVerification = { source: 'store-read'; readId: string; sha256: string };
export type TransferObservation =
  | { stage: 'authorized'; status: 204 }
  | { stage: 'provide-prepared'; receipt: DurableAccessReceipt }
  | { stage: 'unit-length'; unit: string; length: number }
  | { stage: 'bytes'; unit: string; start: number; end: number; verifiedBy: RangeVerification | null }
  | { stage: 'transfer-ended' } | { stage: 'transfer-aborted' } | { stage: 'transfer-unknown' };
export type UnitStatus = 'complete' | 'unverified' | 'partial' | 'unconfirmed' | 'mismatch' | 'not-sent';
export interface RangeRecord { start: number; end: number; response: string; confirmed: boolean; verifiedBy: RangeVerification | null }
export interface DeliveryJudgement {
  outcome: 'complete' | 'incomplete' | 'unknown' | 'mismatch' | 'no-body';
  receiver: DeliveryReceiver;
  units: readonly { key: string; status: UnitStatus; confirmed: readonly (readonly [number, number])[]; verified: readonly (readonly [number, number])[];
    ranges: readonly RangeRecord[] }[];
  responses: readonly { eventId: string; prepared: boolean; terminal: 'transfer-ended' | 'transfer-aborted' | 'transfer-unknown' | null }[];
}
const sameReceiver = (a: DeliveryReceiver, b: DeliveryReceiver) => a.relation === b.relation && a.institution === b.institution &&
  a.accountGeneration === b.accountGeneration && a.openingId === b.openingId && a.sequence === b.sequence;
/** Each stage is its own access record. 'transfer-unknown' has no EMR-A v1 action: B's next format names it (R2). */
export const DELIVERY_STAGE_ACCESS_ACTION: Readonly<Record<'provide-prepared' | 'transfer-ended' | 'transfer-aborted' | 'transfer-unknown', AccessAction | null>> =
  freeze({ 'provide-prepared': 'provide-prepared', 'transfer-ended': 'transfer-ended', 'transfer-aborted': 'transfer-aborted', 'transfer-unknown': null });

function union(ranges: readonly (readonly [number, number])[]): [number, number][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]), out: [number, number][] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e); else out.push([s, e]);
  }
  return out;
}
const covered = (ranges: [number, number][], length: number) => ranges.length === 1 && ranges[0][0] === 0 && ranges[0][1] === length;

export function judgeDelivery(responses: readonly { prepared: PreparedDelivery; observations: readonly TransferObservation[] }[]): Readonly<DeliveryJudgement> {
  if (!Array.isArray(responses) || !responses.length) refuse('PreparedDeliveryRequired');
  const first = responses[0]?.prepared;
  if (!first || !prepared.has(first)) refuse('PreparedDeliveryRequired');
  const units = new Map<string, { unit: DeliveryUnit; ranges: RangeRecord[]; derivedDone: boolean }>();
  const summary: DeliveryJudgement['responses'][number][] = [], seen = new Set<string>();
  let unknown = false;
  for (const response of responses) {
    const r = object(response, ['prepared', 'observations']), p: PreparedDelivery = r.prepared;
    if (!p || !prepared.has(p)) refuse('PreparedDeliveryRequired');
    if (seen.has(p.eventId)) refuse('DuplicateResponse');
    seen.add(p.eventId);
    // Ranges are combined only within one fixed manifest version; a changed study is a new delivery.
    if (p.manifestSha256 !== first.manifestSha256) refuse('ManifestVersionMismatch');
    // A resumed delivery continues one receiver's provision: another account generation, opening, institution or
    // relation is a different provision and its bytes never complete this one.
    if (!sameReceiver(p.receiver, first.receiver)) refuse('DeliveryContextMismatch');
    if (!Array.isArray(r.observations)) refuse('ObservationOrderInvalid');
    for (const u of p.units) if (!units.has(u.key)) units.set(u.key, { unit: u, ranges: [], derivedDone: false });
    let durable = false, terminal: DeliveryJudgement['responses'][number]['terminal'] = null;
    const lengths = new Map<string, number>(), written: { key: string; range: [number, number]; verifiedBy: RangeVerification | null }[] = [];
    for (const raw of r.observations) {
      const stage = (raw as any)?.stage;
      if (terminal !== null) refuse('ObservationOrderInvalid');
      if (stage === 'authorized') { const o = object(raw, ['stage', 'status']); if (o.status !== 204 || durable) refuse('ObservationOrderInvalid'); continue; }
      if (stage === 'provide-prepared') {
        if (durable) refuse('ObservationOrderInvalid');
        const receipt = object(object(raw, ['stage', 'receipt']).receipt, ['eventId', 'durableAt']);
        if (receipt.eventId !== p.eventId) refuse('DurabilityReceiptMismatch');
        utc(receipt.durableAt); durable = true; continue;
      }
      if (stage === 'transfer-ended' || stage === 'transfer-aborted' || stage === 'transfer-unknown') {
        object(raw, ['stage']);
        if (!durable && stage === 'transfer-ended') refuse('BodyBeforeDurableReceipt');
        terminal = stage; continue;
      }
      // provideAfterDurableEvent: no body byte before the durable preparation receipt.
      if (!durable) refuse('BodyBeforeDurableReceipt');
      if (!p.body) refuse('BodyOnHeadRequest');
      if (stage === 'unit-length') {
        const o = object(raw, ['stage', 'unit', 'length']), u = p.units.find(x => x.key === o.unit) ?? refuse('UnitOutsideDelivery');
        const length = integer(o.length);
        if ((u.expectedBytes !== null && length !== u.expectedBytes) || (lengths.has(u.key) && lengths.get(u.key) !== length)) refuse('UnitLengthMismatch');
        lengths.set(u.key, length); continue;
      }
      if (stage !== 'bytes') refuse('ObservationOrderInvalid');
      const o = object(raw, ['stage', 'unit', 'start', 'end', 'verifiedBy']), u = p.units.find(x => x.key === o.unit) ?? refuse('UnitOutsideDelivery');
      const start = integer(o.start), end = integer(o.end, 1), length = u.expectedBytes ?? lengths.get(u.key);
      if (length === undefined || start >= end || end > length) refuse('RangeOutsideUnit');
      let verifiedBy: RangeVerification = null;
      if (o.verifiedBy !== null) {
        // Only a manifest-bound unit has a fixed hash to verify against; a generated body cannot claim one.
        if (u.sha256 === null) refuse('VerificationNotApplicable');
        const v = object(o.verifiedBy, ['source', 'readId', 'sha256']);
        verifiedBy = { source: choice(v.source, ['store-read'] as const), readId: string(v.readId), sha256: sha256(v.sha256) };
      }
      written.push({ key: u.key, range: [start, end], verifiedBy });
    }
    const confirmed = terminal === 'transfer-ended';
    if (terminal === null || terminal === 'transfer-unknown') unknown = true;
    for (const w of written) units.get(w.key).ranges.push({ start: w.range[0], end: w.range[1], response: p.eventId, confirmed, verifiedBy: w.verifiedBy });
    if (confirmed) for (const [key, length] of lengths) {
      const slot = units.get(key);
      // A generated body (metadata, rendering) is complete only within the one response that wrote all of it.
      if (slot.unit.expectedBytes === null && covered(union(written.filter(w => w.key === key).map(w => w.range)), length)) slot.derivedDone = true;
    }
    summary.push({ eventId: p.eventId, prepared: durable, terminal });
  }
  const span = (list: RangeRecord[]) => union(list.map(x => [x.start, x.end] as const));
  const result = [...units.values()].map(slot => {
    const length = slot.unit.expectedBytes;
    const confirmed = span(slot.ranges.filter(x => x.confirmed)), any = span(slot.ranges);
    // Verification is kept per range: only confirmed bytes written from a read whose hash equals the manifest count.
    const verified = slot.unit.sha256 === null ? [] : span(slot.ranges.filter(x => x.confirmed && x.verifiedBy?.sha256 === slot.unit.sha256));
    const mismatch = slot.unit.sha256 !== null && slot.ranges.some(x => x.verifiedBy !== null && x.verifiedBy.sha256 !== slot.unit.sha256);
    const status: UnitStatus = mismatch ? 'mismatch'
      : length === null ? (slot.derivedDone ? 'complete' : confirmed.length ? 'partial' : any.length ? 'unconfirmed' : 'not-sent')
      : covered(verified, length) ? 'complete'
      : covered(confirmed, length) ? 'unverified'
      : any.length && covered(any, length) ? 'unconfirmed' : confirmed.length ? 'partial' : any.length ? 'unconfirmed' : 'not-sent';
    return { key: slot.unit.key, status, confirmed, verified, ranges: slot.ranges };
  });
  const body = responses.some(r => r.prepared.body);
  const outcome: DeliveryJudgement['outcome'] = !body ? 'no-body'
    : result.some(u => u.status === 'mismatch') ? 'mismatch'
    : result.every(u => u.status === 'complete') ? 'complete' : unknown ? 'unknown' : 'incomplete';
  return freeze({ outcome, receiver: first.receiver, units: result, responses: summary });
}

/** A commit whose result is unknown is re-read by its original event ID; it is never assumed stored or lost. */
export interface DurableEventLookup {
  findByEventId(eventId: string): Promise<{ status: 'found'; receipt: DurableAccessReceipt } | { status: 'absent'; complete: true }>;
}
export async function resolveUnknownAppend(eventId: string, lookup: DurableEventLookup):
  Promise<Readonly<{ status: 'durable'; receipt: DurableAccessReceipt } | { status: 'absent' } | { status: 'unknown' }>> {
  string(eventId);
  let found: any;
  try { found = await lookup.findByEventId(eventId); } catch { return freeze({ status: 'unknown' as const }); }
  if (found?.status === 'found') {
    const receipt = object(found.receipt, ['eventId', 'durableAt']);
    if (receipt.eventId !== eventId) refuse('DurabilityReceiptMismatch');
    return freeze({ status: 'durable' as const, receipt: { eventId, durableAt: utc(receipt.durableAt) } });
  }
  // "Not found" from a partial or failed scan is not proof of absence.
  if (found?.status === 'absent' && found.complete === true) return freeze({ status: 'absent' as const });
  return freeze({ status: 'unknown' as const });
}

// ---------------------------------------------------------------------------------------------------------------
// Offline bundle: Offline Ready only when the managed device verified every byte of the reading set and the viewer.

export interface OfflinePart { key: string; kind: 'object' | 'text' | 'decoder' | 'viewer'; bytes: number | null; sha256: string }
export interface OfflineBundlePlan {
  bundleId: string; patient: ImageManifest['patient']; currentStudyUid: string; manifests: readonly { studyUid: string; sha256: string; role: 'current' | 'comparison' }[];
  missingComparisons: readonly string[]; parts: readonly OfflinePart[]; excluded: readonly { studyUid: string; sopInstanceUid: string; reason: string }[];
  totalBytes: number; sha256: string;
}
const plans = new WeakSet<object>();
const samePatient = (a: ImageManifest['patient'], b: ImageManifest['patient']) =>
  a.linkId === b.linkId && a.patientId === b.patientId && a.assigningAuthority === b.assigningAuthority;

export function planOfflineBundle(input: { bundleId: string; current: ImageManifest; comparisons: { selected: readonly string[]; manifests: readonly ImageManifest[] };
  texts: readonly { recordId: string; versionId: string; bytes: number; sha256: string }[] }): Readonly<OfflineBundlePlan> {
  const v = object(input, ['bundleId', 'current', 'comparisons', 'texts']);
  const bundleId = string(v.bundleId), current = verifiedManifest(v.current), cmp = object(v.comparisons, ['selected', 'manifests']);
  if (!Array.isArray(cmp.selected) || !Array.isArray(cmp.manifests) || !Array.isArray(v.texts)) refuse('ComparisonSelectionInvalid');
  const selected = cmp.selected.map(dicomUid);
  if (new Set(selected).size !== selected.length || selected.includes(current.studyUid)) refuse('ComparisonSelectionInvalid');
  const manifests = cmp.manifests.map(verifiedManifest);
  for (const m of manifests) {
    // Only what the reader chose is copied to the device, and only for this patient at this institution.
    if (!selected.includes(m.studyUid) || manifests.filter(x => x.studyUid === m.studyUid).length !== 1) refuse('ComparisonNotSelected');
    if (!samePatient(m.patient, current.patient) || m.managingInstitution !== current.managingInstitution) refuse('ComparisonPatientMismatch');
  }
  const all = [current, ...manifests], parts: OfflinePart[] = [], excluded: OfflineBundlePlan['excluded'][number][] = [];
  for (const m of all) for (const o of m.objects) {
    if (o.unsupported) excluded.push({ studyUid: m.studyUid, sopInstanceUid: o.sopInstanceUid, reason: o.unsupported });
    else parts.push({ key: `object:${m.studyUid}/${o.sopInstanceUid}`, kind: 'object', bytes: o.bytes, sha256: o.sha256 });
  }
  for (const t of v.texts) {
    const x = object(t, ['recordId', 'versionId', 'bytes', 'sha256']);
    parts.push({ key: `text:${string(x.recordId)}@${string(x.versionId)}`, kind: 'text', bytes: integer(x.bytes, 1), sha256: sha256(x.sha256) });
  }
  const decoders = new Map<string, { version: string; sha256: string }>();
  for (const m of all) for (const d of m.decoders) {
    const seen = decoders.get(d.id);
    if (seen && (seen.version !== d.version || seen.sha256 !== d.sha256)) refuse('DecoderAssetConflict');
    decoders.set(d.id, { version: d.version, sha256: d.sha256 });
  }
  for (const [id, d] of [...decoders].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)) parts.push({ key: `decoder:${id}@${d.version}`, kind: 'decoder', bytes: null, sha256: d.sha256 });
  if (all.some(m => m.viewer.id !== current.viewer.id || m.viewer.version !== current.viewer.version || m.viewer.sha256 !== current.viewer.sha256)) refuse('ViewerAssetConflict');
  parts.push({ key: `viewer:${current.viewer.id}@${current.viewer.version}`, kind: 'viewer', bytes: null, sha256: current.viewer.sha256 });
  if (new Set(parts.map(x => x.key)).size !== parts.length) refuse('OfflinePartConflict');
  const missingComparisons = selected.filter(uid => !manifests.some(m => m.studyUid === uid));
  const manifestRefs = all.map((m, i) => ({ studyUid: m.studyUid, sha256: m.sha256, role: i ? 'comparison' as const : 'current' as const }));
  const totalBytes = parts.reduce((sum, x) => sum + (x.bytes ?? 0), 0);
  const digest = createHash('sha256').update(JSON.stringify({ bundleId, manifestRefs, missingComparisons, parts })).digest('hex');
  const plan = freeze({ bundleId, patient: current.patient, currentStudyUid: current.studyUid, manifests: manifestRefs, missingComparisons, parts, excluded, totalBytes, sha256: digest });
  plans.add(plan);
  return plan;
}

export type ReadinessReason = { code: 'bundle-stale' | 'comparison-missing' | 'object-unsupported' | 'object-missing' | 'text-missing' | 'decoder-missing' |
  'viewer-missing' | 'part-mismatch' | 'storage-insufficient' | 'journal-insufficient'; key: string | null };
/** Device facts come from C's managed-device store (R2); Q/J/H/ε margins are inside C's requiredBytes, never chosen here. */
export interface OfflineDeviceState {
  bundleId: string; planSha256: string; verified: readonly { key: string; bytes: number | null; sha256: string }[];
  storage: { freeBytes: number; requiredBytes: number }; journal: { freeBytes: number; requiredBytes: number };
}
export function offlineReadiness(planInput: OfflineBundlePlan, device: OfflineDeviceState): Readonly<{ ready: boolean; reasons: readonly ReadinessReason[] }> {
  if (!planInput || !plans.has(planInput)) refuse('OfflinePlanRequired');
  const plan = planInput;
  const d = object(device, ['bundleId', 'planSha256', 'verified', 'storage', 'journal']);
  const storage = object(d.storage, ['freeBytes', 'requiredBytes']), journal = object(d.journal, ['freeBytes', 'requiredBytes']);
  [storage.freeBytes, storage.requiredBytes, journal.freeBytes, journal.requiredBytes].forEach(n => integer(n));
  if (storage.requiredBytes < plan.totalBytes) refuse('StorageRequirementInconsistent');
  const reasons: ReadinessReason[] = [];
  if (d.bundleId !== plan.bundleId || d.planSha256 !== plan.sha256) reasons.push({ code: 'bundle-stale', key: null });
  for (const uid of plan.missingComparisons) reasons.push({ code: 'comparison-missing', key: uid });
  // Online, an unsupported object is refused by name while the rest of the study opens. Offline Ready claims the whole
  // reading set is on the device, so every object left out of the copy keeps the bundle not ready, by name.
  for (const x of plan.excluded) reasons.push({ code: 'object-unsupported', key: `object:${x.studyUid}/${x.sopInstanceUid}` });
  if (!Array.isArray(d.verified)) refuse('OfflinePlanRequired');
  const verified = new Map<string, { bytes: number | null; sha256: string }>();
  for (const raw of d.verified) {
    const x = object(raw, ['key', 'bytes', 'sha256']);
    if (verified.has(string(x.key))) refuse('OfflinePlanRequired');
    verified.set(x.key, { bytes: x.bytes === null ? null : integer(x.bytes), sha256: sha256(x.sha256) });
  }
  for (const part of plan.parts) {
    const got = verified.get(part.key);
    if (!got) reasons.push({ code: `${part.kind}-missing` as ReadinessReason['code'], key: part.key });
    else if (got.sha256 !== part.sha256 || got.bytes !== part.bytes) reasons.push({ code: 'part-mismatch', key: part.key });
  }
  if (storage.freeBytes < storage.requiredBytes) reasons.push({ code: 'storage-insufficient', key: null });
  if (journal.freeBytes < journal.requiredBytes) reasons.push({ code: 'journal-insufficient', key: null });
  return freeze({ ready: reasons.length === 0, reasons });
}

/** Grant expiry or an explicit end stops offline viewing; the queued records are kept for upload either way. */
export function offlineAccess(grant: { grantId: string; notAfter: string; endedAt: string | null }, at: string):
  Readonly<{ viewAllowed: boolean; reason: 'grant-active' | 'grant-expired' | 'grant-ended'; queuePreserved: true }> {
  const g = object(grant, ['grantId', 'notAfter', 'endedAt']); string(g.grantId);
  const now = utc(at), notAfter = utc(g.notAfter), ended = g.endedAt === null ? null : utc(g.endedAt);
  const reason = ended !== null && ended <= now ? 'grant-ended' as const : notAfter <= now ? 'grant-expired' as const : 'grant-active' as const;
  return freeze({ viewAllowed: reason === 'grant-active', reason, queuePreserved: true as const });
}

export interface OfflineViewRecord {
  eventId: string; deviceId: string; deviceSequence: number; occurredAt: string; clock: 'device'; userId: ImmutableIdentity; grantId: string;
  studyUid: string; sopInstanceUid: string | null; frame: number | null; trustedProxyIp: EvidenceFact<{ address: string; source: 'trusted-proxy' }>;
}
const offlineRecords = new WeakSet<object>();
/** An offline view keeps the device's own time, device and order. No network address was observed, and none is invented. */
export function sealOfflineView(input: { eventId: string; deviceId: string; deviceSequence: number; occurredAt: string; userId: ImmutableIdentity; grantId: string;
  studyUid: string; sopInstanceUid: string | null; frame: number | null }): Readonly<OfflineViewRecord> {
  const v = object(input, ['eventId', 'deviceId', 'deviceSequence', 'occurredAt', 'userId', 'grantId', 'studyUid', 'sopInstanceUid', 'frame']);
  const record = freeze({ eventId: string(v.eventId), deviceId: string(v.deviceId), deviceSequence: integer(v.deviceSequence, 1), occurredAt: utc(v.occurredAt),
    clock: 'device' as const, userId: identity(v.userId), grantId: string(v.grantId), studyUid: dicomUid(v.studyUid),
    sopInstanceUid: v.sopInstanceUid === null ? null : dicomUid(v.sopInstanceUid), frame: v.frame === null ? null : integer(v.frame, 1),
    trustedProxyIp: { status: 'unresolved' as const, reason: 'not-observed' as const } });
  offlineRecords.add(record);
  return record;
}
/** Reconnection is its own event with the address seen then; the offline records upload unchanged beside it. */
export function reconnectRecord(offline: readonly OfflineViewRecord[], reconnect: { eventId: string; deviceId: string; at: string; trustedProxyIp: { address: string; source: 'trusted-proxy' } }):
  Readonly<{ reconnect: { eventId: string; deviceId: string; at: string; trustedProxyIp: EvidenceFact<{ address: string; source: 'trusted-proxy' }>; relatedOfflineEventIds: readonly string[] };
    offline: readonly OfflineViewRecord[] }> {
  const r = object(reconnect, ['eventId', 'deviceId', 'at', 'trustedProxyIp']);
  const ip = object(r.trustedProxyIp, ['address', 'source']);
  if (isIP(string(ip.address)) === 0 || ip.source !== 'trusted-proxy') refuse('TrustedProxyIpRequired');
  if (!Array.isArray(offline)) refuse('OfflineSequenceConflict');
  const deviceId = string(r.deviceId), eventId = string(r.eventId);
  let last = 0;
  for (const record of offline) {
    if (!offlineRecords.has(record)) refuse('OfflineRecordRequired');
    if (record.deviceId !== deviceId) refuse('OfflineDeviceMismatch');
    if (record.deviceSequence <= last || record.eventId === eventId) refuse('OfflineSequenceConflict');
    last = record.deviceSequence;
  }
  if (new Set(offline.map(x => x.eventId)).size !== offline.length) refuse('OfflineSequenceConflict');
  return freeze({ reconnect: { eventId, deviceId, at: utc(r.at), trustedProxyIp: { status: 'known' as const, value: { address: ip.address, source: 'trusted-proxy' as const } },
    relatedOfflineEventIds: offline.map(x => x.eventId) }, offline: [...offline] });
}

// ---------------------------------------------------------------------------------------------------------------
// Display records: the client reports what this opening actually showed; prefetch is not display, a re-display from
// cache is still a display, and an ACK binds to a display of the current opening only (A→B→A, account switch).

export interface Opening { openingId: string; accountGeneration: number; sequence: number; studyUid: string; manifestSha256: string; closedAt: string | null }
export interface DisplayReport {
  openingId: string; accountGeneration: number; sequence: number; studyUid: string; manifestSha256: string; sopInstanceUid: string; frame: number | null;
  source: 'network' | 'cache' | 'offline-store'; cause: CauseKind; deliveryEventId: string | null; reportedAt: string;
}
export interface DisplayRecord {
  action: 'client-shown'; openingId: string; accountGeneration: number; sequence: number; studyUid: string; manifestSha256: string;
  unitKey: string; source: DisplayReport['source']; relatedEventId: string | null; reportedAt: string;
}
const shown = new WeakSet<object>();
function opening(value: unknown): Opening {
  const o = object(value, ['openingId', 'accountGeneration', 'sequence', 'studyUid', 'manifestSha256', 'closedAt']);
  return { openingId: string(o.openingId), accountGeneration: integer(o.accountGeneration, 1), sequence: integer(o.sequence, 1), studyUid: dicomUid(o.studyUid),
    manifestSha256: sha256(o.manifestSha256), closedAt: o.closedAt === null ? null : utc(o.closedAt) };
}
const sameOpening = (a: { openingId: string; accountGeneration: number; sequence: number }, b: Opening) =>
  a.openingId === b.openingId && a.accountGeneration === b.accountGeneration && a.sequence === b.sequence;

/** A network display needs a response that carried a body (never HEAD) and a displayable unit of that object: its
 * pixels, frame, rendering or document; a unit without a frame number carries every frame. Metadata and header bulk
 * attributes such as PixelSpacing are not what the reader saw. */
function displayedBy(delivery: PreparedDelivery, sopInstanceUid: string, frame: number | null): boolean {
  return delivery.body && delivery.units.some(u => u.displayable && u.sopInstanceUid === sopInstanceUid && (frame === null || u.frame === null || u.frame === frame));
}
/** delivery: the prepared delivery a network display names (null for a cache or offline-store re-display). */
export function classifyDisplayReport(currentInput: Opening, manifestInput: ImageManifest, report: DisplayReport, delivery: PreparedDelivery | null): Readonly<DisplayRecord> {
  const current = opening(currentInput), manifest = verifiedManifest(manifestInput);
  const r = object(report, ['openingId', 'accountGeneration', 'sequence', 'studyUid', 'manifestSha256', 'sopInstanceUid', 'frame', 'source', 'cause', 'deliveryEventId', 'reportedAt']);
  if (current.closedAt !== null) refuse('OpeningClosed');
  if (!sameOpening(r as any, current) || r.studyUid !== current.studyUid) refuse('StaleOpeningRefused');
  if (r.manifestSha256 !== current.manifestSha256 || manifest.sha256 !== current.manifestSha256 || manifest.studyUid !== current.studyUid) refuse('ManifestVersionMismatch');
  // Prefetch and service loads put bytes in a cache; only the reading view showing them is a display.
  if (choice(r.cause, ['user-view', 'background-fetch', 'service-job']) !== 'user-view') refuse('BackgroundIsNotDisplay');
  const item = manifest.objects.find(o => o.sopInstanceUid === r.sopInstanceUid);
  if (!item || item.unsupported) refuse('ScopeOutsideManifest');
  const frame = r.frame === null ? null : integer(r.frame, 1);
  if (frame !== null && !item.frames.some(f => f.number === frame)) refuse('FrameOutOfManifest');
  const source = choice(r.source, ['network', 'cache', 'offline-store'] as const);
  // A network display names the delivery it showed; a cache or offline re-display is recorded without a new delivery.
  if ((source === 'network') !== (r.deliveryEventId !== null) || (source !== 'network' && delivery !== null)) refuse('DisplaySourceMismatch');
  // That delivery was prepared for this opening's reading view and carried this object's pixels (not only its metadata).
  if (source === 'network' && (!delivery || !prepared.has(delivery) || delivery.eventId !== r.deliveryEventId || delivery.manifestSha256 !== current.manifestSha256 ||
      delivery.cause !== 'user-view' || !delivery.opening || !sameOpening(delivery.opening, current) || !displayedBy(delivery, item.sopInstanceUid, frame)))
    refuse('DisplayDeliveryMismatch');
  const record = freeze({ action: 'client-shown' as const, openingId: current.openingId, accountGeneration: current.accountGeneration, sequence: current.sequence,
    studyUid: current.studyUid, manifestSha256: current.manifestSha256, unitKey: frame === null ? `object:${item.sopInstanceUid}` : `frame:${item.sopInstanceUid}#${frame}`,
    source, relatedEventId: r.deliveryEventId === null ? null : string(r.deliveryEventId), reportedAt: utc(r.reportedAt) });
  shown.add(record);
  return record;
}

export function acceptExplicitAck(currentInput: Opening, display: DisplayRecord, ack: { openingId: string; accountGeneration: number; sequence: number; at: string }):
  Readonly<{ action: 'explicit-ack'; openingId: string; accountGeneration: number; sequence: number; unitKey: string; relatedShownAt: string; at: string }> {
  const current = opening(currentInput);
  if (!display || !shown.has(display)) refuse('AckWithoutDisplay');
  const a = object(ack, ['openingId', 'accountGeneration', 'sequence', 'at']);
  if (current.closedAt !== null) refuse('OpeningClosed');
  // An ACK from an earlier opening or account generation never lands on the current one, even for the same study.
  if (!sameOpening(a as any, current) || !sameOpening(display, current) || display.manifestSha256 !== current.manifestSha256) refuse('StaleAckRefused');
  return freeze({ action: 'explicit-ack' as const, openingId: current.openingId, accountGeneration: current.accountGeneration, sequence: current.sequence,
    unitKey: display.unitKey, relatedShownAt: display.reportedAt, at: utc(a.at) });
}
