import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { EmrRecordTransaction } from '../emr-runtime/record-port';
import type { ImageManifest } from './manifest';
import type { TransferObservation } from './contract';
import type { ImageCopy, ImageEvidenceStore, ImageResponseManifest } from './stream';

// The exact JSON of a built study manifest and the digest that names it, made once per manifest: the frames of a
// kept manifest (manifest-reuse.ts) share one object.
const bodies = new WeakMap<ImageManifest, { text: string; sha256: string }>();
function body(source: ImageManifest) {
  let kept = bodies.get(source);
  if (!kept) {
    const text = JSON.stringify(source);
    kept = { text, sha256: createHash('sha256').update(text).digest('hex') };
    bodies.set(source, kept);
  }
  return kept;
}

/** Detail rows use the same connection as B2's provide/transfer operation.
 * No row here decides whether an operation committed: that belongs to B2. */
export class PgImageEvidenceStore implements ImageEvidenceStore {
  constructor(private readonly db: PrismaClient) {}

  async prepared(tx: EmrRecordTransaction, manifest: ImageResponseManifest,
    source: ImageManifest, copies: readonly ImageCopy[]): Promise<void> {
    // The study manifest's exact body is kept once and each preparation names it. A copy per preparation repeated the
    // whole-study body (about 160 KB for a 200-slice CT) for every frame inside the B2 commit transaction: about a tenth
    // of a frame's append-lane time on the served CT (run e-route-diag2-opus-20261026a), and its storage per frame.
    const { text, sha256 } = body(source);
    const [kept] = await tx.$queryRaw<{ found: boolean }[]>`SELECT EXISTS (SELECT FROM emr_image.source_manifest
      WHERE body_sha256 = ${sha256}) AS found`;
    if (!kept.found) await tx.$executeRaw`INSERT INTO emr_image.source_manifest (body_sha256, study_uid, body)
      VALUES (${sha256}, ${source.studyUid}, ${text}::jsonb) ON CONFLICT (body_sha256) DO NOTHING`;
    await tx.$executeRaw`INSERT INTO emr_image.preparation
      (event_id, study_uid, source_manifest_body, response_manifest, staging_copies)
      VALUES (${manifest.eventId}::uuid, ${manifest.studyUid}::text, ${sha256},
        ${JSON.stringify(manifest)}::jsonb, ${JSON.stringify(copies)}::jsonb)`;
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
