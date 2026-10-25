import type { PrismaClient } from '@prisma/client';
import type { EmrRecordTransaction } from '../emr-runtime/record-port';
import type { ImageManifest } from './manifest';
import type { TransferObservation } from './contract';
import type { ImageCopy, ImageEvidenceStore, ImageResponseManifest } from './stream';

/** Detail rows use the same connection as B2's provide/transfer operation.
 * No row here decides whether an operation committed: that belongs to B2. */
export class PgImageEvidenceStore implements ImageEvidenceStore {
  constructor(private readonly db: PrismaClient) {}

  async prepared(tx: EmrRecordTransaction, manifest: ImageResponseManifest,
    source: ImageManifest, copies: readonly ImageCopy[]): Promise<void> {
    await tx.$executeRaw`INSERT INTO emr_image.preparation
      (event_id, study_uid, source_manifest, response_manifest, staging_copies)
      VALUES (${manifest.eventId}::uuid, ${manifest.studyUid}::text,
        ${JSON.stringify(source)}::jsonb, ${JSON.stringify(manifest)}::jsonb,
        ${JSON.stringify(copies)}::jsonb)`;
  }

  async transferred(tx: EmrRecordTransaction, eventId: string,
    observations: readonly TransferObservation[],
    wire: Parameters<ImageEvidenceStore['transferred']>[3]): Promise<void> {
    await tx.$executeRaw`INSERT INTO emr_image.observation (event_id, kind, body)
      VALUES (${eventId}::uuid, 'transport', ${JSON.stringify({ observations, wire })}::jsonb)`;
  }

  async copiesRemoved(eventId: string, copies: readonly ImageCopy[]): Promise<void> {
    // Cleanup is recorded even if the preparation transaction rolled back.
    await this.db.$executeRaw`INSERT INTO emr_image.observation (event_id, kind, body)
      VALUES (${eventId}::uuid, 'copies', ${JSON.stringify(copies)}::jsonb)`;
  }
}
