import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { canonicalPayload } from '../emr-contract/signature';
import { refuse } from '../emr-contract/validation';
import { applyPlan, projectUnit } from '../emr-clinical/records';
import { clinicalSigningContent } from '../emr-clinical/signing';
import type { StoredClinicalVersion } from '../emr-clinical/store';
import type { StoredApproval } from '../emr-report/online-store';
import { verifyRegisteredServerEnvelope } from '../emr-signature/server-verification';
import type { PackageVersion } from './contract';
import { bindFixedListing, FixedListing } from './fixed-listing';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Only stored D/C2 originals enter this adapter. The legacy F listing remains
 * available for its original reader; online signatures retain their own payload. */
export async function loadFixedVersions(tx: Prisma.TransactionClient, recordId: string): Promise<object> {
  const clinical = await tx.$queryRaw<{ body: string; signature: string | null }[]>`
    SELECT body,signature FROM emr_clinical.online_version WHERE record_id=${recordId} ORDER BY sequence`;
  const reports = await tx.$queryRaw<{ outcome: StoredApproval }[]>`
    SELECT outcome FROM emr_signing.signed_version WHERE record_id=${recordId}`;
  if ((!clinical.length && !reports.length) || (clinical.length && reports.length)) refuse('VersionListingIncomplete');
  let subject: FixedListing['subject'], versions: PackageVersion[] = [], bytes: string[] = [];
  if (clinical.length) {
    let unit: ReturnType<typeof applyPlan> = null;
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
  } else {
    const remaining = reports.map(r => r.outcome);
    let previous: PackageVersion = null;
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
  }
  return bindFixedListing({ recordId, revision: versions.at(-1).sha256, subject, versions }, bytes);
}
