import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Prisma, ReportVersion } from '@prisma/client';
import { canonicalPayload } from '../emr-contract/signature';
import { refuse } from '../emr-contract/validation';
import { applyPlan, projectUnit } from '../emr-clinical/records';
import { clinicalSigningContent } from '../emr-clinical/signing';
import type { StoredClinicalVersion } from '../emr-clinical/store';
import type { StoredApproval } from '../emr-report/online-store';
import { verifyRegisteredServerEnvelope } from '../emr-signature/server-verification';
import type { PackageVersion, RecordKind } from './contract';
import { bindFixedListing, FixedListing } from './fixed-listing';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
// native-signing.ts digest(): the previous version's hash is over the stored row as Prisma returns it.
const digest = (value: unknown) => hash(JSON.stringify(value));
const NATIVE_ACTIONS: Readonly<Record<string, string>> = { approve: 'approve-sign', addendum: 'addendum', reset: 'cancel' };

type Stored = { clinical: { body: string; signature: string | null }[]; reports: { outcome: StoredApproval }[]; native: ReportVersion[] };
async function stored(tx: Prisma.TransactionClient, recordId: string): Promise<Stored> {
  const clinical = await tx.$queryRaw<Stored['clinical']>`
    SELECT body,signature FROM emr_clinical.online_version WHERE record_id=${recordId} ORDER BY sequence`;
  const reports = await tx.$queryRaw<Stored['reports']>`
    SELECT outcome FROM emr_signing.signed_version WHERE record_id=${recordId}`;
  const native = await tx.reportVersion.findMany({ where: { uid: recordId }, orderBy: { version: 'asc' } });
  return { clinical, reports, native };
}
/** A Study UID names both its Tech Note (pacs-routes.ts) and its native report (native-signing.ts). Without a
 * selector only a record held by one store is read; F never picks one of two sources for the requester. */
function kindOf(s: Stored, selected?: RecordKind): RecordKind | null {
  const held = { clinical: s.clinical.length > 0, report: s.reports.length > 0 || s.native.length > 0 };
  if (selected) return held[selected] ? selected : null;
  if (held.clinical && held.report) refuse('RecordKindAmbiguous');
  return held.clinical ? 'clinical' : held.report ? 'report' : null;
}
/** Intake refuses only an unselected record held by both stores. A missing original keeps the request and its hold. */
export async function requireRecordKind(tx: Prisma.TransactionClient, recordId: string, selected?: RecordKind): Promise<void> {
  kindOf(await stored(tx, recordId), selected);
}

/** Only stored D/C2/native originals enter this adapter. The legacy F listing remains
 * available for its original reader; online signatures retain their own payload. */
export async function loadFixedVersions(tx: Prisma.TransactionClient, recordId: string, selected?: RecordKind): Promise<object> {
  const s = await stored(tx, recordId), kind = kindOf(s, selected);
  if (!kind) refuse('VersionListingIncomplete');
  const read = kind === 'clinical' ? clinicalVersions(recordId, s.clinical)
    : s.native.length ? await nativeVersions(tx, recordId, s.native, s.reports.map(r => r.outcome))
    : signedVersions(recordId, s.reports.map(r => r.outcome));
  return bindFixedListing({ recordId, recordKind: kind, revision: read.versions.at(-1).sha256, subject: read.subject, versions: read.versions }, read.bytes);
}

type Read = { subject: FixedListing['subject']; versions: PackageVersion[]; bytes: string[] };
function clinicalVersions(recordId: string, clinical: Stored['clinical']): Read {
  let subject: FixedListing['subject'], unit: ReturnType<typeof applyPlan> = null;
  const versions: PackageVersion[] = [], bytes: string[] = [];
  for (const row of clinical) {
    const plan: StoredClinicalVersion['plan'] = JSON.parse(row.body);
    unit = applyPlan(unit, plan); projectUnit(unit);
    const v = plan.version;
    if (v.recordId !== recordId) refuse('VersionListingRefused');
    let signature: PackageVersion['signature'] = null;
    if (plan.signing) {
      if (row.signature === null) refuse('SignatureEvidenceRequired');
      const s: StoredClinicalVersion['signature'] = JSON.parse(row.signature);
      const verified = verifyRegisteredServerEnvelope(s.envelope, s.registration);
      if (!canonicalPayload(verified.payload).equals(canonicalPayload({ ...clinicalSigningContent(plan.signing), serverTime: s.signedAt })) ||
          verified.versionSha256 !== s.payloadSha256) refuse('SignatureEvidenceMismatch');
      signature = { keyId: s.registration.kid, envelopeSha256: hash(JSON.stringify(s.envelope)),
        publicKeyEvidenceId: s.registration.kid, identityEvidenceId: s.registration.doctor.identityRegistrationId };
    } else if (row.signature !== null) refuse('SignatureEvidenceMismatch');
    subject = { patient: v.patient, studyId: v.studyId, managingInstitutionId: v.managingInstitutionId };
    versions.push({ versionId: v.versionId, at: v.at, act: v.act, sha256: v.sha256,
      contentSha256: v.contentSha256 ?? hash(JSON.stringify(v)), predecessor: v.previousVersion &&
        { versionId: v.previousVersion.versionId, sha256: v.previousVersion.sha256 }, signature });
    bytes.push(JSON.stringify({ plan: row.body, signature: row.signature }));
  }
  return { subject, versions, bytes };
}

/** C2 originals without native rows (OnlineApproval): the signed versions chain by their own payload digests. */
function signedVersions(recordId: string, outcomes: StoredApproval[]): Read {
  const remaining = [...outcomes], versions: PackageVersion[] = [], bytes: string[] = [];
  let subject: FixedListing['subject'], previous: PackageVersion = null;
  while (remaining.length) {
    const next = remaining.filter(r => {
      const p = verifyRegisteredServerEnvelope(r.envelope, r.keyAtSigning).payload.previousVersion;
      return previous ? p?.versionId === previous.versionId && p.sha256 === previous.sha256 : p === null;
    });
    if (next.length !== 1) refuse('VersionListingIncomplete');
    const r = next[0], verified = verifyRegisteredServerEnvelope(r.envelope, r.keyAtSigning), p = verified.payload;
    if (p.recordId !== recordId || p.versionId !== r.versionId || verified.versionSha256 !== r.versionSha256) refuse('SignatureEvidenceMismatch');
    const current = { patient: p.patient, studyId: p.studyId, managingInstitutionId: p.managingInstitutionId };
    if (subject && JSON.stringify(subject) !== JSON.stringify(current)) refuse('DisclosureSubjectMismatch');
    subject = current;
    previous = { versionId: r.versionId, at: r.signedAt, act: p.action, sha256: r.versionSha256,
      contentSha256: hash(JSON.stringify(p.text)), predecessor: previous && { versionId: previous.versionId, sha256: previous.sha256 },
      signature: { keyId: r.kid, envelopeSha256: hash(JSON.stringify(r.envelope)), publicKeyEvidenceId: r.kid,
        identityEvidenceId: r.keyAtSigning.doctor.identityRegistrationId } };
    versions.push(previous); bytes.push(JSON.stringify(r)); remaining.splice(remaining.indexOf(r), 1);
  }
  return { subject, versions, bytes };
}

/** The shared native report is its head chain: every ReportVersion except discarded rows (a content reset's
 * snapshot or a force-discarded private draft), in version order with gaps. report-commit.ts signs approve,
 * addendum and a reset of an existing report, binding the stored row and the previous head row's digest.
 * Unsigned saves stay in the chain with no signature; they are never presented as signed. */
async function nativeVersions(tx: Prisma.TransactionClient, recordId: string, rows: ReportVersion[], outcomes: StoredApproval[]): Promise<Read> {
  const head = rows.filter(r => r.action !== 'discarded');
  const report = await tx.report.findUnique({ where: { uid: recordId }, select: { version: true } });
  if (!head.length || report?.version !== head[head.length - 1].version) refuse('VersionListingIncomplete');
  const signatures = new Map<string, StoredApproval>();
  for (const outcome of outcomes) {
    if (signatures.has(outcome.versionId)) refuse('SignatureEvidenceMismatch');
    signatures.set(outcome.versionId, outcome);
  }
  // A signature on a discarded or missing version describes no shared report version.
  if ([...signatures.keys()].some(id => !head.some(r => String(r.version) === id))) refuse('SignatureEvidenceMismatch');
  let subject: FixedListing['subject'], previous: PackageVersion = null;
  const versions: PackageVersion[] = [], bytes: string[] = [];
  for (const [index, row] of head.entries()) {
    const versionId = String(row.version), body = JSON.stringify(row), before = index ? head[index - 1] : null;
    const required = row.action in NATIVE_ACTIONS && (row.action !== 'reset' || before !== null);
    const r = signatures.get(versionId);
    if (required && !r) refuse('SignatureEvidenceRequired');
    let signature: PackageVersion['signature'] = null;
    if (r) {
      if (!required) refuse('SignatureEvidenceMismatch');
      const verified = verifyRegisteredServerEnvelope(r.envelope, r.keyAtSigning), p = verified.payload;
      if (r.recordId !== recordId || r.versionId !== versionId || verified.versionSha256 !== r.versionSha256 ||
          p.recordKind !== 'report-version' || p.recordId !== recordId || p.versionId !== versionId || p.studyId !== recordId ||
          p.action !== NATIVE_ACTIONS[row.action] || p.text?.kind !== 'clinical-entry' || typeof p.text.body !== 'string' ||
          !isDeepStrictEqual(JSON.parse(p.text.body), JSON.parse(body)) ||
          !isDeepStrictEqual(p.previousVersion, before ? { recordId, versionId: String(before.version), sha256: digest(before) } : null))
        refuse('SignatureEvidenceMismatch');
      const current = { patient: p.patient, studyId: p.studyId, managingInstitutionId: p.managingInstitutionId };
      if (subject && JSON.stringify(subject) !== JSON.stringify(current)) refuse('DisclosureSubjectMismatch');
      subject = current;
      signature = { keyId: r.kid, envelopeSha256: hash(JSON.stringify(r.envelope)), publicKeyEvidenceId: r.kid,
        identityEvidenceId: r.keyAtSigning.doctor.identityRegistrationId };
    }
    previous = { versionId, at: row.at.toISOString(), act: row.action, sha256: digest(row),
      contentSha256: hash(JSON.stringify({ kind: 'clinical-entry', body })),
      predecessor: previous && { versionId: previous.versionId, sha256: previous.sha256 }, signature };
    versions.push(previous);
    bytes.push(r ? JSON.stringify(r) : JSON.stringify({ reportVersion: body }));
  }
  // Saves alone are a draft history, not a fixed version (and carry no signed patient/institution subject).
  if (!signatures.size) refuse('VersionListingIncomplete');
  return { subject, versions, bytes };
}
