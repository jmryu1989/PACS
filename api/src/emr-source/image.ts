import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { PrismaService } from '../prisma.service';
import { ClinicalContextSource, ClinicalRequestFacts } from '../emr-clinical/runtime';
import { CURRENT_CLINICAL_CONTEXT } from '../emr-clinical/startup';
import { StudyFacts } from '../emr-clinical/contract';
import { REQUEST_CONTEXT_SOURCE, RequestContextSource } from '../emr-runtime/request-context';
import { BackgroundWork, EMR_BACKGROUND_WORK } from '../emr-runtime/background-work';
import { EmrRecordTransaction } from '../emr-runtime/record-port';
import { CurrentImageFacts, ImageCatalogSource } from '../emr-image/context';
import { checkProvisionBasis, ImageRequest } from '../emr-image/contract';
import { AssetPin, buildImageManifest, FrameDigest, ManifestObjectInput, Provenance, SOP_CLASSES } from '../emr-image/manifest';

const unavailable = (code: string): never => {
  throw new ServiceUnavailableException({ code, message: '영상 원본과 배포된 뷰어 정보를 확인할 수 없습니다.' });
};
const value = (header: any, tag: string) => header?.[tag]?.Value?.[0];

type AssetFile = { size: number; mtimeMs: number; ino: number; sha256: string };
const assetFiles = new Map<string, AssetFile>();
/** The installed bytes of one file. A file is hashed again when its size, modification time or inode changes,
 * which every deployment of a new distribution does. */
async function fileDigest(path: string): Promise<string> {
  const before = await stat(path), known = assetFiles.get(path);
  if (known && known.size === before.size && known.mtimeMs === before.mtimeMs && known.ino === before.ino) return known.sha256;
  const part = createHash('sha256');
  for await (const bytes of createReadStream(path)) part.update(bytes);
  const after = await stat(path);
  // A file replaced while it was read has no single digest; nothing is cached and the catalog is refused.
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) unavailable('ImageAssetCatalogUnavailable');
  const sha256 = part.digest('hex');
  assetFiles.set(path, { size: before.size, mtimeMs: before.mtimeMs, ino: before.ino, sha256 });
  return sha256;
}

/** Deployment identifies the installed files, not their claimed digests. The
 * catalog hashes those actual viewer/decoder bytes for E's existing AssetPin. */
export async function deployedImageAssets(file = process.env.KIN_EMR_IMAGE_ASSET_CATALOG) {
  if (!file) unavailable('ImageAssetCatalogUnavailable');
  let catalog: any;
  try { catalog = JSON.parse(await readFile(file, 'utf8')); } catch { unavailable('ImageAssetCatalogUnavailable'); }
  const pin = async (entry: { id: string; version: string; files: string[] }): Promise<AssetPin> => {
    if (!entry || typeof entry.id !== 'string' || !entry.id || typeof entry.version !== 'string' || !entry.version ||
        !Array.isArray(entry.files) || !entry.files.length) unavailable('ImageAssetCatalogUnavailable');
    const digest = createHash('sha256');
    for (const path of entry.files) {
      // The ordered distribution is the versioned asset, including workers and
      // WASM files. Length-prefixed names keep concatenated files unambiguous.
      digest.update(JSON.stringify(path) + '\n');
      let part: string;
      try { part = await fileDigest(resolve(dirname(file), path)); }
      catch (error) { if (error instanceof ServiceUnavailableException) throw error; unavailable('ImageAssetCatalogUnavailable'); }
      digest.update(Buffer.from(part, 'hex'));
    }
    return { id: entry.id, version: entry.version, sha256: digest.digest('hex') };
  };
  const viewer = await pin(catalog?.viewer), decoderCatalog: Record<string, { version: string; sha256: string }> = {};
  for (const [id, entry] of Object.entries(catalog?.decoders ?? {})) {
    const asset = await pin({ ...(entry as any), id });
    decoderCatalog[id] = { version: asset.version, sha256: asset.sha256 };
  }
  return { viewer, decoderCatalog };
}

type Digest = { bytes: number; sha256: string };
type StoredDigests = { file: string; original?: Digest; frames: Map<number, Digest> };
/** What a manifest takes from one stored file: its transfer syntax and the digests of its bytes and frames. */
type FileDigests = Digest & { transferSyntaxUid: unknown; frames: FrameDigest[] };
/** One listed archive object as a build reads it: the stored file it is now, and the frames its header declares. */
type ListedObject = { instanceId: string; file: string | null; sop: unknown; frameCount: number };

const pixelFormat = (header: any) => {
  const format = SOP_CLASSES[value(header, '00080016')]?.format ?? 'unsupported';
  return { format, pixel: format === 'image' || format === 'segmentation' };
};
function declaredFrames(header: any): number {
  const count = pixelFormat(header).pixel ? Number(value(header, '00280008') ?? 1) : 0;
  if (!Number.isSafeInteger(count) || count < 0) unavailable('ImageFrameCountUnreadable');
  return count;
}

/** The spec of the cold first opening (#248) fixes four archive objects read at a time: the two full reads of each
 * object are the cost, and one object after another multiplies it by the object count. */
const OBJECTS_READ_AT_ONCE = 4;
/** The gateway agent's `/changes` defaults (POLL_SECONDS 2, limit 100), the one consumer of Orthanc's change log here. */
const CHANGES_POLL_MS = 2000, CHANGES_PAGE = 100;

async function bounded<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0, failure: { error: unknown } | null = null;
  // After a failure no further object starts; those already reading finish or see the request's abort.
  const lane = async () => {
    while (!failure && next < items.length) {
      const item = items[next++];
      try { await work(item); } catch (error) { failure ??= { error }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  if (failure) throw failure.error;
}

/** Read-only Orthanc catalog. No metadata supplied by the browser establishes
 * the patient, object version, frame digest or source provenance. */
@Injectable()
export class OrthancImageCatalog implements ImageCatalogSource, OnModuleInit, OnModuleDestroy {
  /** Digests of a stored file still being read, kept as each part completes: a request that ends part-way through
   * a large multiframe object leaves its finished frames for the next one. Once a build or the change follower
   * keeps the file's row in emr_image.object_digest the entry is dropped. Delivery still hashes the bytes it stages. */
  private readonly digests = new Map<string, StoredDigests>();
  private readonly logger = new Logger('OrthancImageCatalog');
  private stopFollowing?: () => void;
  private since: number | null = null;
  private followFailing = false;

  constructor(private readonly db: PrismaService,
    @Inject(CURRENT_CLINICAL_CONTEXT) private readonly clinical: ClinicalContextSource,
    @Inject(REQUEST_CONTEXT_SOURCE) private readonly requests: RequestContextSource,
    @Inject(EMR_BACKGROUND_WORK) private readonly background: BackgroundWork) {}

  onModuleInit() {
    // Digests are made when a study has arrived (StableStudy), not when a reader first opens it.
    this.stopFollowing = this.background.every('emr-image.objectDigests', CHANGES_POLL_MS, signal => this.follow(signal));
  }
  onModuleDestroy() { this.stopFollowing?.(); }

  private async response(path: string, signal: AbortSignal, body?: string) {
    const user = process.env.ORTHANC_USER, pass = process.env.ORTHANC_PASS;
    if (!user || !pass) unavailable('ImageSourceUnavailable');
    const response = await fetch((process.env.ORTHANC_URL ?? 'http://orthanc:8042').replace(/\/$/, '') + path, {
      method: body === undefined ? 'GET' : 'POST', body, signal, redirect: 'error',
      headers: { Authorization: 'Basic ' + Buffer.from(user + ':' + pass).toString('base64'), 'Accept-Encoding': 'identity' },
    });
    if (!response.ok || !response.body) { await response.body?.cancel(); unavailable('ImageSourceUnavailable'); }
    return response;
  }
  private async json(path: string, signal: AbortSignal, body?: string) {
    const text = await (await this.response(path, signal, body)).text();
    try { return JSON.parse(text); } catch { return unavailable('ImageSourceUnavailable'); }
  }
  private async digest(path: string, signal: AbortSignal) {
    const response = await this.response(path, signal), digest = createHash('sha256');
    let bytes = 0;
    for await (const part of response.body as any as AsyncIterable<Uint8Array>) {
      signal.throwIfAborted(); digest.update(part); bytes += part.length;
    }
    return { bytes, sha256: digest.digest('hex') };
  }
  private resource(id: unknown): string {
    if (typeof id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{8}){4}$/.test(id)) unavailable('ImageSourceUnavailable');
    return id as string;
  }
  private async objectDigests({ instanceId, file, frameCount }: ListedObject, signal: AbortSignal): Promise<FileDigests> {
    const meta = await this.json(`/instances/${instanceId}/header`, signal);
    // Without a stored-file identity nothing tells a later request that the bytes are the same; nothing is kept.
    let stored: StoredDigests = { file: '', frames: new Map() };
    if (file) {
      const known = this.digests.get(instanceId);
      if (known?.file === file) stored = known; else this.digests.set(instanceId, stored = { file, frames: new Map() });
    }
    stored.original ??= await this.digest(`/instances/${instanceId}/file`, signal);
    const frames: FrameDigest[] = [];
    for (let frame = 0; frame < frameCount; frame++) {
      let done = stored.frames.get(frame);
      if (!done) stored.frames.set(frame, done = await this.digest(`/instances/${instanceId}/frames/${frame}/raw`, signal));
      frames.push({ number: frame + 1, ...done });
    }
    return { transferSyntaxUid: meta?.['0002,0010']?.Value, ...stored.original, frames };
  }

  /** Each listed object's digests: the kept row of the stored file it is now, else read from the archive, a few
   * objects at a time. `read` names the objects whose digests were read here and are not kept yet. */
  private async fileDigests(objects: readonly ListedObject[], signal: AbortSignal) {
    const found = new Map<string, FileDigests>(), wanted = objects.filter(object => object.file);
    const rows = wanted.length ? await this.db.$queryRaw<any[]>`SELECT instance_id, file_uuid, sop_instance_uid,
        transfer_syntax_uid, bytes, sha256, frames FROM emr_image.object_digest
      WHERE (instance_id, file_uuid) IN (SELECT * FROM unnest(${wanted.map(o => o.instanceId)}::text[], ${wanted.map(o => o.file)}::text[]))` : [];
    const byId = new Map(wanted.map(object => [object.instanceId, object]));
    for (const row of rows) {
      const object = byId.get(row.instance_id);
      // A row stands only for what this build would read itself: the same stored file, SOP instance and declared frames.
      if (!object || row.file_uuid !== object.file || row.sop_instance_uid !== object.sop || !Array.isArray(row.frames) ||
          row.frames.length !== object.frameCount || row.frames.some((f: any, i: number) => f?.number !== i + 1)) continue;
      found.set(object.instanceId, { transferSyntaxUid: row.transfer_syntax_uid, bytes: Number(row.bytes), sha256: row.sha256,
        frames: row.frames.map((f: any) => ({ number: f.number, bytes: f.bytes, sha256: f.sha256 })) });
    }
    const read = objects.filter(object => !found.has(object.instanceId));
    await bounded(read, OBJECTS_READ_AT_ONCE, async object => { found.set(object.instanceId, await this.objectDigests(object, signal)); });
    return { found, read };
  }

  /** Keeps the digests of stored files read here. Called only after a re-list shows each file still listed; a row
   * that cannot be kept leaves the next opening to read the file again, it never changes this one. */
  private async keep(objects: readonly ListedObject[], found: ReadonlyMap<string, FileDigests>) {
    const rows = objects.flatMap(object => {
      const digests = found.get(object.instanceId);
      return object.file && typeof object.sop === 'string' && typeof digests?.transferSyntaxUid === 'string'
        ? [{ instance_id: object.instanceId, file_uuid: object.file, sop_instance_uid: object.sop,
          transfer_syntax_uid: digests.transferSyntaxUid, bytes: digests.bytes, sha256: digests.sha256, frames: digests.frames }] : [];
    });
    if (!rows.length) return;
    try {
      await this.db.$executeRaw`INSERT INTO emr_image.object_digest
          (instance_id, file_uuid, sop_instance_uid, transfer_syntax_uid, bytes, sha256, frames)
        SELECT * FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS r(instance_id text, file_uuid text,
          sop_instance_uid text, transfer_syntax_uid text, bytes bigint, sha256 text, frames jsonb)
        ON CONFLICT (instance_id, file_uuid) DO NOTHING`;
      for (const row of rows) if (this.digests.get(row.instance_id)?.file === row.file_uuid) this.digests.delete(row.instance_id);
    } catch (error: any) {
      this.logger.warn(`Object digests not kept (${error?.code ?? error?.name ?? 'storage'}); the next opening reads them again`);
    }
  }

  /** One page loop over Orthanc's change log from where this process started following it. A study that arrived
   * while no API process followed the log is read by its first opening instead, which keeps the rows then. */
  private async follow(signal: AbortSignal) {
    try {
      if (this.since === null) {
        const last = Number((await this.json('/changes?last', signal))?.Last);
        if (!Number.isSafeInteger(last) || last < 0) unavailable('ImageSourceUnavailable');
        this.since = last;
      }
      for (;;) {
        const page = await this.json(`/changes?since=${this.since}&limit=${CHANGES_PAGE}`, signal);
        const last = Number(page?.Last);
        if (!Array.isArray(page?.Changes) || !Number.isSafeInteger(last)) unavailable('ImageSourceUnavailable');
        for (const change of page.Changes) {
          if (change?.ChangeType !== 'StableStudy') continue;
          // One study that cannot be read now (removed, replaced meanwhile) is left to its first opening.
          try { await this.digestStudy(change.ID, signal); } catch { signal.throwIfAborted(); }
        }
        this.since = Math.max(this.since, last);
        if (page.Done !== false) break;
      }
      if (this.followFailing) this.logger.log('Following the archive change log again');
      this.followFailing = false;
    } catch (error: any) {
      if (signal.aborted) return;
      if (!this.followFailing) this.logger.warn(`Archive change log not readable (${error?.response?.code ?? error?.name ?? 'error'}); first openings read their objects`);
      this.followFailing = true;
    }
  }

  private async digestStudy(orthancId: unknown, signal: AbortSignal) {
    const id = this.resource(orthancId);
    const uid = (await this.json(`/studies/${id}`, signal))?.MainDicomTags?.StudyInstanceUID;
    if (typeof uid !== 'string' || !uid) unavailable('ImageStudyUnresolved');
    const listed = await this.json(`/studies/${id}/instances`, signal);
    const headers = await this.json(`/dicom-web/studies/${encodeURIComponent(uid)}/metadata`, signal);
    if (!Array.isArray(listed) || !Array.isArray(headers)) unavailable('ImageCatalogIncomplete');
    const objects: ListedObject[] = [];
    for (const instance of listed) {
      const sop = instance?.MainDicomTags?.SOPInstanceUID, file = instance?.FileUuid;
      const candidates = headers.filter(header => value(header, '00080018') === sop);
      // What the opening would refuse is not digested ahead of it; the opening refuses it by its own checks.
      if (candidates.length !== 1 || typeof file !== 'string' || !file) continue;
      let frameCount: number;
      try { frameCount = declaredFrames(candidates[0]); } catch { continue; }
      objects.push({ instanceId: this.resource(instance.ID), file, sop, frameCount });
    }
    const { found, read } = await this.fileDigests(objects, signal);
    const after = await this.json(`/studies/${id}/instances`, signal);
    if (!Array.isArray(after)) unavailable('ImageCatalogChanged');
    // Only files still listed after their reads are kept: a digest read while its object was replaced may be of the new file.
    await this.keep(read.filter(object => after.some(row => row?.ID === object.instanceId && row?.FileUuid === object.file)), found);
    for (const object of read) this.digests.delete(object.instanceId);
  }

  async manifest(request: object, image: ImageRequest, signal: AbortSignal) {
    // Authorization and the deployment's own preconditions come before reading the archive; the delivery
    // boundary checks the same context again after staging and before publishing bytes.
    const study = await this.db.$transaction(tx => this.clinical.study(tx, request, image.studyUid));
    if (this.requests.read(request as any).institution !== study.managingInstitutionId) unavailable('ProcessingAgreementRequired');
    // The build runs as long as its requester waits (the signal ends with the request); digests finished
    // before it ends are kept above, so a large study opens across retries instead of being refused.
    return this.catalog(study, image, await deployedImageAssets(), signal);
  }

  private async catalog(study: StudyFacts, image: ImageRequest, assets: Awaited<ReturnType<typeof deployedImageAssets>>, signal: AbortSignal) {
    const found = await this.json('/tools/lookup', signal, image.studyUid);
    const matches = Array.isArray(found) ? found.filter(row => row.Type === 'Study') : [];
    if (matches.length !== 1) unavailable('ImageStudyUnresolved');
    const id = this.resource(matches[0].ID);
    const listed = await this.json(`/studies/${id}/instances`, signal);
    if (!Array.isArray(listed) || !listed.length) unavailable('ImageCatalogIncomplete');
    const headers = await this.json(`/dicom-web/studies/${encodeURIComponent(image.studyUid)}/metadata`, signal);
    if (!Array.isArray(headers) || headers.length !== listed.length) unavailable('ImageCatalogIncomplete');
    // Every check that needs no archive object comes first, so a refused study costs no object read.
    const planned = listed.map(instance => {
      const instanceId = this.resource(instance.ID), sop = instance.MainDicomTags?.SOPInstanceUID;
      const candidates = headers.filter(header => value(header, '00080018') === sop);
      if (candidates.length !== 1) unavailable('ImageCatalogIncomplete');
      const header = candidates[0];
      if (value(header, '0020000D') !== study.studyId || value(header, '00100020') !== study.patient.patientId)
        unavailable('ImageCurrentStudyChanged');
      const object: ListedObject = { instanceId, sop, frameCount: declaredFrames(header),
        file: typeof instance.FileUuid === 'string' && instance.FileUuid ? instance.FileUuid : null };
      const refs = (header['00082112']?.Value ?? []).map((item: any) => {
        const target = headers.find(h => value(h, '00080018') === value(item, '00081155'));
        // Do not manufacture a study/series for an unresolved outside reference.
        if (!target) unavailable('ImageDerivedSourceUnavailable');
        return { studyUid: value(target, '0020000D'), seriesUid: value(target, '0020000E'), sopInstanceUid: value(target, '00080018') };
      });
      return { object, header, refs };
    });
    const { found: digested, read } = await this.fileDigests(planned.map(p => p.object), signal);
    const objects: ManifestObjectInput[] = [];
    for (const { object: { instanceId, sop, frameCount: declaredFrameCount }, header, refs } of planned) {
      const seriesUid = value(header, '0020000E'), sopClassUid = value(header, '00080016');
      const { format, pixel } = pixelFormat(header);
      const { frames, transferSyntaxUid, ...original } = digested.get(instanceId)!;
      let provenance: Provenance = { kind: 'device', receiptEventId: null };
      if (['structured-report', 'segmentation', 'encapsulated-pdf'].includes(format)) {
        const manual = format === 'structured-report' ? await this.db.manualSr.findFirst({
          where: { studyUid: study.studyId, orthancId: instanceId, sha256: original.sha256, storedAt: { not: null } } }) : null;
        // A scanner dose SR, a KOS or a received PDF has no product receipt naming its producer yet. It is listed
        // and refused by name; the study's images still open.
        provenance = manual ? { kind: 'product-authored', recordId: manual.id } : { kind: 'unestablished' };
      }
      const imageType = pixel ? header['00080008']?.Value ?? null : null;
      const family = SOP_CLASSES[sopClassUid]?.family;
      // The manifest checks these values as it did when each was read here; a kept row is the same file's read.
      objects.push({ studyUid: image.studyUid, seriesUid, sopInstanceUid: sop as string, sopClassUid, transferSyntaxUid: transferSyntaxUid as string,
        ...original, declaredFrameCount, frames, provenance, imageType,
        derivation: !pixel ? { kind: 'not-image' } : imageType?.[0] === 'ORIGINAL' ? { kind: 'original' }
          : imageType?.[0] === 'DERIVED' ? { kind: 'derived', sources: refs } : { kind: 'unknown' },
        mammography: family === 'mammography-2d' || family === 'breast-tomosynthesis'
          ? { header, declaredSources: null, claimedClass: null } : null,
        timing: header['00181065']?.Value ? { source: 'frame-time-vector', vectorMs: header['00181065'].Value.map(Number) }
          : header['00181063']?.Value ? { source: 'frame-time', frameTimeMs: Number(value(header, '00181063')) } : null });
    }
    const after = await this.json(`/studies/${id}/instances`, signal);
    if (!Array.isArray(after) || after.length !== listed.length ||
        after.some(row => !listed.some(before => before.ID === row.ID && before.FileUuid === row.FileUuid))) {
      // Digests read while an object was being replaced may be of the new file; none of this study's are kept.
      for (const instance of listed) this.digests.delete(instance.ID);
      unavailable('ImageCatalogChanged');
    }
    await this.keep(read, digested);
    return buildImageManifest({ formatVersion: 1, studyUid: image.studyUid,
      managingInstitution: study.managingInstitutionId, patient: study.patient, builtAt: new Date().toISOString(),
      expected: { series: new Set(objects.map(o => o.seriesUid)).size, objects: objects.length },
      pages: [{ cursor: null, next: null, objects }], referencedObjects: [], ...assets });
  }

  async delivery(tx: EmrRecordTransaction, request: object, facts: ClinicalRequestFacts, study: StudyFacts, at: string):
    Promise<Pick<CurrentImageFacts, 'accountGeneration' | 'provision'>> {
    // Current identity is read from Orthanc after the clinical scope lookup. Hold
    // the institution row through this delivery decision so a concurrent move
    // cannot publish bytes using the scope read before that move.
    const [locked] = await tx.$queryRaw<{ institutionId: string; teleInstitutionId: string | null }[]>`
      SELECT "institutionId", "teleInstitutionId" FROM "StudyState" WHERE uid=${study.studyId} FOR SHARE`;
    if (!locked || locked.institutionId !== study.managingInstitutionId || locked.teleInstitutionId !== study.teleInstitutionId)
      unavailable('ImageCurrentStudyChanged');
    const current = this.requests.read(request as any);
    if (facts.actor.institutionId !== study.managingInstitutionId) unavailable('ProcessingAgreementRequired');
    return { accountGeneration: current.rightsVersion, provision: checkProvisionBasis({ relation: 'same-institution', at,
      managingInstitution: study.managingInstitutionId, studyUid: study.studyId, recipient: null, purpose: null,
      basis: null, agreement: null, auditBefore: null }) };
  }
}
