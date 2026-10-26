import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { FindingService } from '../finding.service';
import { canonical } from '../viewer-input';
import { sourceStudies } from '../finding-input';
import { emrAdapters } from '../emr-contract/composition';
import { resolveStoredRecord } from '../emr-contract/classification';
import { retentionFor } from '../emr-contract/lawful-defaults';
import { refuse } from '../emr-contract/validation';
import { snapshotFromRows, transactionScope, withSnapshot } from '../emr-runtime/context';
import type { RequestIdentityPort } from '../emr-signature/server-contract';
import type { ClinicalRouteSources } from '../emr-clinical/routes';

const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const key = (id: string, revision: number) => JSON.stringify([id, revision]);

/** The immutable source and its first stored time travel with D's prepared
 * command. Editing/hiding a source later cannot replace a finding's old copy. */
interface FixedSource {
  recordId: string; model: string; row: Record<string, any>;
  event: { eventId: string; recordId: string; versionId: string; sha256: string; contentSha256: string;
    at: string; act: 'creation' | 'correction'; signature: null; predecessor: null; components: []; processing: null };
  startedAt: string;
}

async function storedSource(tx: Prisma.TransactionClient, source: any): Promise<FixedSource> {
  const job = source.kind === 'job', id = job ? source.jobId : source.itemId, revision = source.revision;
  let row: Record<string, any>, at: Date, startedAt: Date;
  // Snapshots cross as JSON text: the query engine's Json conversion can move a 17-digit double by one
  // ULP (viewer-job-snapshot.ts), and this copy must be the stored bytes the finding's own copy was taken from.
  if (job) {
    const [head] = await tx.$queryRaw<any[]>`SELECT "studyUid", "authorSub", studies, snapshot::text AS snapshot
      FROM "ViewerJob" WHERE id = ${id}::uuid`;
    const fixed = await tx.viewerJobRevision.findUnique({ where: { jobId_revision: { jobId: id, revision } } });
    const first = await tx.viewerJobRevision.findFirst({ where: { jobId: id }, orderBy: { revision: 'asc' } });
    if (!head || !fixed || !first) refuse('FindingFixedVersionMissing');
    // ViewerJob.snapshot is immutable; metadata revisions contain their own title,
    // description, author and time. A layout reference does not adopt its text.
    row = { ...fixed, snapshot: JSON.parse(head.snapshot), studies: head.studies, studyUid: head.studyUid,
      authorSub: head.authorSub, clinicalEntry: false };
    at = fixed.at; startedAt = first.at;
  } else {
    const head = await tx.viewerItem.findUnique({ where: { id }, select: { studyUid: true, authorSub: true } });
    const [fixed] = await tx.$queryRaw<any[]>`SELECT "itemId", revision, snapshot::text AS snapshot, action, reason, actor, "payloadBytes", at
      FROM "ViewerRevision" WHERE "itemId" = ${id}::uuid AND revision = ${revision}`;
    const first = await tx.viewerRevision.findFirst({ where: { itemId: id }, orderBy: { revision: 'asc' }, select: { at: true } });
    if (!head || !fixed || !first) refuse('FindingFixedVersionMissing');
    const snapshot = JSON.parse(fixed.snapshot);
    row = { ...fixed, studyUid: head.studyUid, authorSub: head.authorSub,
      snapshot: { ...snapshot, type: snapshot.kind === 'key' ? 'key-image' : 'measurement' } };
    at = fixed.at; startedAt = first.at;
  }
  // Dates are serialized once, as they will be in the stored command on replay.
  row = JSON.parse(JSON.stringify(row));
  const digest = hash(row), versionId = String(revision);
  return { recordId: id, model: job ? 'ViewerJobRevision' : 'ViewerRevision', row,
    event: { eventId: key(id, revision), recordId: id, versionId, sha256: digest, contentSha256: hash(row.snapshot),
      at: at.toISOString(), act: revision === 1 ? 'creation' : 'correction', signature: null,
      predecessor: null, components: [], processing: null }, startedAt: startedAt.toISOString() };
}

export function findingSources(findings: FindingService, identity: RequestIdentityPort): ClinicalRouteSources {
  return async (tx, request, write) => {
    const current = await identity.resolve(tx, request);
    const saved = await findings.prepare(write.studyId, Buffer.from(JSON.stringify(write.body)), {
      sub: current.actor.identity.subject, actor: (request as any).actor ?? current.actor.identity.subject,
      institution: current.actor.institutionId, roles: [...current.actor.roles], kind: 'member',
    }, write.surface === 'finding.create' ? undefined : write.recordId, tx, write.recordId);
    const previous = await tx.$queryRaw<{ body: string }[]>`SELECT c.body FROM emr_clinical.online_command c
      JOIN emr_clinical.online_version v ON v.operation_id=c.operation_id
      WHERE v.record_type='finding' AND v.record_id=${write.recordId} AND v.sequence<=${saved.revision}
      ORDER BY v.sequence DESC LIMIT 1`;
    const old: FixedSource[] = previous.length ? JSON.parse(previous[0].body).projection?.fixedSources ?? [] : [];
    const fixed = new Map<string, FixedSource>();
    for (const source of saved.item.sources) {
      const id = source.kind === 'job' ? source.jobId : source.itemId, eventId = key(id, source.revision);
      if (fixed.has(eventId)) continue;
      const kept = old.find(row => row.recordId === id && row.event.eventId === eventId);
      fixed.set(eventId, kept ?? await storedSource(tx, source));
    }
    const scope = transactionScope();
    const snapshot = snapshotFromRows(scope, { holds: new Map(), accessRequests: new Map(), correctionRequests: new Map(),
      clauseVersions: new Map(), accessEvents: new Map(), fixedRecords: new Map([...fixed.values()].map(row =>
        [row.event.eventId, { recordId: row.recordId, model: row.model, row: row.row, event: row.event }])) });
    const attachments = withSnapshot(scope, snapshot, () => [...fixed.values()].map(row =>
      resolveStoredRecord(emrAdapters().stored, row.recordId, row.event.eventId)));
    return { content: canonical(saved.item), attachments,
      navigation: [...new Set(saved.item.sources.flatMap(sourceStudies))].filter(uid => uid !== write.studyId) as string[],
      recipientId: null, readerId: null, workContext: { kind: 'reading', studyId: write.studyId, referenceId: write.studyId },
      projection: { fixedSources: [...fixed.values()], retention: attachments.map((source, i) => ({
        recordId: source.recordId, startedAt: [...fixed.values()][i].startedAt, policy: retentionFor(source.kinds),
      })) } };
  };
}
