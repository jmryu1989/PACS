import type { Prisma } from '@prisma/client';
import { emrAdapters } from '../emr-contract/composition';
import { resolveStoredRecord, retentionDisposition } from '../emr-contract/classification';
import { refuse } from '../emr-contract/validation';
import { CLINICAL_SURFACES, ClinicalVersion } from '../emr-clinical/contract';
import { snapshotFromRows, transactionScope, withSnapshot } from '../emr-runtime/context';
import { lockFixedRecords } from '../emr-runtime/fixed-record-lock';
import { loadFixedVersions } from './fixed-versions';
import { fixedOriginals, onlineFixedListing } from './fixed-listing';
import type { RecordKind, RightsRecord } from './contract';

/** Reuse F's verified D/C2/native originals. Model/discriminators come from stored versions,
 * never from request fields; the selector only names the store. A owns the classification and F owns the decision. */
export async function rightsRecords(tx: Prisma.TransactionClient, ids: readonly string[],
  kinds: Readonly<Record<string, RecordKind>> = {}): Promise<RightsRecord[]> {
  await lockFixedRecords(tx, ids);
  const sources = [];
  for (const id of ids) {
    const listing = await loadFixedVersions(tx, id, kinds[id]), fixed = onlineFixedListing(listing);
    const originals = fixedOriginals(listing, fixed.versions.map(v => v.versionId));
    for (const [index, version] of fixed.versions.entries()) {
      const original = JSON.parse(originals[index].original);
      let model = 'ReportVersion', row: Record<string, unknown> = {};
      if (original.plan) {
        const v: ClinicalVersion = JSON.parse(original.plan).version;
        const spec = CLINICAL_SURFACES[v.surface];
        if (!spec) refuse('RightsRecordUnsupported');
        model = spec.model;
        if (model === 'StudyQuestionEntry') row.kind = v.kind === 'clinical-answer' ? 'answer' : 'question';
        if (model === 'TechNoteRevision') row.authorRole = v.capacity === 'clinical-author' ? 'radiographer' : 'administrator';
      }
      const eventId = JSON.stringify([id, version.versionId]);
      sources.push({ subject: fixed.subject, stored: { recordId: id, model, row, event: {
        eventId, recordId: id, versionId: version.versionId, sha256: version.sha256, contentSha256: version.contentSha256,
        at: version.at, act: version.predecessor ? 'correction' : 'creation',
        signature: version.signature ? { versionId: version.versionId, sha256: version.sha256, signedAt: version.at, verified: true } : null,
        predecessor: version.predecessor ? { recordId: id, partId: version.predecessor.versionId, sha256: version.predecessor.sha256 } : null,
        components: [], processing: null,
      } } });
    }
  }
  const scope = transactionScope(), snapshot = snapshotFromRows(scope, {
    fixedRecords: new Map(sources.map(s => [s.stored.event.eventId, s.stored])),
    holds: new Map(), accessRequests: new Map(), correctionRequests: new Map(), clauseVersions: new Map(), accessEvents: new Map(),
  });
  const resolved = withSnapshot(scope, snapshot, () => sources.map(s => ({
    subject: { patient: s.subject.patient, managingInstitutionId: s.subject.managingInstitutionId },
    record: resolveStoredRecord(emrAdapters().stored, s.stored.recordId, s.stored.event.eventId),
  })));
  // F accepts one classification per requested record. Do not let a later operational
  // entry silently stand in for an earlier clinical original in the same unit.
  return ids.map(id => {
    const versions = resolved.filter(r => r.record.recordId === id);
    if (new Set(versions.map(r => retentionDisposition(r.record))).size !== 1) refuse('RightsRecordAmbiguous');
    return versions.at(-1);
  });
}
