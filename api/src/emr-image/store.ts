import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { ImageManifest } from './manifest';
import type { TransferObservation } from './contract';
import type { ImageCopy, ImageEvidenceStore, ImageResponseManifest } from './stream';

// The exact JSON of a built study manifest and the digest that names it, made once per manifest: the frames of a
// kept manifest (manifest-reuse.ts) share one object. `stored` remembers that this process already wrote the body
// (ON CONFLICT DO NOTHING keeps a restart or a second process from writing it twice).
const bodies = new WeakMap<ImageManifest, { text: string; sha256: string; stored: boolean }>();
function body(source: ImageManifest) {
  let kept = bodies.get(source);
  if (!kept) {
    const text = JSON.stringify(source);
    kept = { text, sha256: createHash('sha256').update(text).digest('hex'), stored: false };
    bodies.set(source, kept);
  }
  return kept;
}

/** E's own rows: each response's fixed representation, transport and copy facts, naming the B2 access record of its
 * study delivery. They are written on the application's connection, durable (synchronous commit) before the first
 * byte; the ledger's append lanes carry only the delivery's own events. No row here decides whether an access record
 * committed: that belongs to B2. */
export class PgImageEvidenceStore implements ImageEvidenceStore {
  constructor(private readonly db: PrismaClient) {}

  async prepared(manifest: ImageResponseManifest, source: ImageManifest, copies: readonly ImageCopy[], requestId: string): Promise<void> {
    // The study manifest's exact body is kept once and each preparation names it (R244-02): a copy per response
    // repeated the whole-study body, about 160 KB for a 200-slice CT, for every frame.
    const kept = body(source);
    if (!kept.stored) {
      await this.db.$executeRaw`INSERT INTO emr_image.source_manifest (body_sha256, study_uid, body)
        VALUES (${kept.sha256}, ${source.studyUid}, ${kept.text}::jsonb) ON CONFLICT (body_sha256) DO NOTHING`;
      kept.stored = true;
    }
    await this.db.$executeRaw`INSERT INTO emr_image.preparation
      (event_id, delivery_event_id, request_id, study_uid, source_manifest_body, response_manifest, staging_copies)
      VALUES (${manifest.eventId}::uuid, ${manifest.deliveryEventId}::uuid, ${requestId}, ${manifest.studyUid}::text, ${kept.sha256},
        ${JSON.stringify(manifest)}::jsonb, ${JSON.stringify(copies)}::jsonb)`;
  }

  async transferred(eventId: string, observations: readonly TransferObservation[],
    wire: Parameters<ImageEvidenceStore['transferred']>[2]): Promise<void> {
    await this.db.$executeRaw`INSERT INTO emr_image.observation (event_id, kind, body)
      VALUES (${eventId}::uuid, 'transport', ${JSON.stringify({ observations, wire })}::jsonb)`;
  }

  async copiesRemoved(eventId: string, copies: readonly ImageCopy[]): Promise<void> {
    // Cleanup is recorded even if the preparation failed.
    await this.db.$executeRaw`INSERT INTO emr_image.observation (event_id, kind, body)
      VALUES (${eventId}::uuid, 'copies', ${JSON.stringify(copies)}::jsonb)`;
  }
}
