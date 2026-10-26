import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { PrismaService } from '../prisma.service';
import { ClinicalContextSource, ClinicalRequestFacts } from '../emr-clinical/runtime';
import { CURRENT_CLINICAL_CONTEXT } from '../emr-clinical/startup';
import { StudyFacts } from '../emr-clinical/contract';
import { REQUEST_CONTEXT_SOURCE, RequestContextSource } from '../emr-runtime/request-context';
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

/** Read-only Orthanc catalog. No metadata supplied by the browser establishes
 * the patient, object version, frame digest or source provenance. */
@Injectable()
export class OrthancImageCatalog implements ImageCatalogSource {
  /** Digests of each archive object's stored file, kept as each one completes. Orthanc writes a changed object to
   * a new file, so a digest never stands for other bytes; a request that ends part-way through a large multiframe
   * object leaves its finished frames for the next one. One entry per archive object: a new file replaces it.
   * Delivery still hashes the bytes it stages. */
  private readonly digests = new Map<string, StoredDigests>();

  constructor(private readonly db: PrismaService,
    @Inject(CURRENT_CLINICAL_CONTEXT) private readonly clinical: ClinicalContextSource,
    @Inject(REQUEST_CONTEXT_SOURCE) private readonly requests: RequestContextSource) {}

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
  private async objectDigests(instance: any, instanceId: string, frameCount: number, signal: AbortSignal):
    Promise<Digest & { frames: FrameDigest[] }> {
    const file = typeof instance.FileUuid === 'string' && instance.FileUuid ? instance.FileUuid : null;
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
    return { ...stored.original, frames };
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
    const objects: ManifestObjectInput[] = [];
    for (const instance of listed) {
      const instanceId = this.resource(instance.ID), sop = instance.MainDicomTags?.SOPInstanceUID;
      const candidates = headers.filter(header => value(header, '00080018') === sop);
      if (candidates.length !== 1) unavailable('ImageCatalogIncomplete');
      const header = candidates[0], seriesUid = value(header, '0020000E'), sopClassUid = value(header, '00080016');
      if (value(header, '0020000D') !== study.studyId || value(header, '00100020') !== study.patient.patientId)
        unavailable('ImageCurrentStudyChanged');
      const meta = await this.json(`/instances/${instanceId}/header`, signal);
      const transferSyntaxUid = meta?.['0002,0010']?.Value;
      const format = SOP_CLASSES[sopClassUid]?.format ?? 'unsupported';
      const pixel = format === 'image' || format === 'segmentation';
      const declaredFrameCount = pixel ? Number(value(header, '00280008') ?? 1) : 0;
      if (!Number.isSafeInteger(declaredFrameCount) || declaredFrameCount < 0) unavailable('ImageFrameCountUnreadable');
      const { frames, ...original } = await this.objectDigests(instance, instanceId, declaredFrameCount, signal);
      let provenance: Provenance = { kind: 'device', receiptEventId: null };
      if (['structured-report', 'segmentation', 'encapsulated-pdf'].includes(format)) {
        const manual = format === 'structured-report' ? await this.db.manualSr.findFirst({
          where: { studyUid: study.studyId, orthancId: instanceId, sha256: original.sha256, storedAt: { not: null } } }) : null;
        // A scanner dose SR, a KOS or a received PDF has no product receipt naming its producer yet. It is listed
        // and refused by name; the study's images still open.
        provenance = manual ? { kind: 'product-authored', recordId: manual.id } : { kind: 'unestablished' };
      }
      const imageType = pixel ? header['00080008']?.Value ?? null : null;
      const refs = (header['00082112']?.Value ?? []).map((item: any) => {
        const target = headers.find(h => value(h, '00080018') === value(item, '00081155'));
        // Do not manufacture a study/series for an unresolved outside reference.
        if (!target) unavailable('ImageDerivedSourceUnavailable');
        return { studyUid: value(target, '0020000D'), seriesUid: value(target, '0020000E'), sopInstanceUid: value(target, '00080018') };
      });
      const family = SOP_CLASSES[sopClassUid]?.family;
      objects.push({ studyUid: image.studyUid, seriesUid, sopInstanceUid: sop, sopClassUid, transferSyntaxUid,
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
