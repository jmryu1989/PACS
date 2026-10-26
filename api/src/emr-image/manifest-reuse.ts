import type { ImageRequest } from './contract';
import { ImageManifest, verifiedManifest } from './manifest';

/** E_ROUTE: one verified study manifest serves that study's image requests until the source stops matching it.
 * The manifest names every object and frame of the study with its digest, so building it reads and hashes the whole
 * study; the viewer then asks for each frame separately. Rebuilding per frame would repeat that whole-study read for
 * every slice of a series. Reuse changes no delivery fact: each response still stages and hashes its own units against
 * this manifest, and the requester's current access is checked on the B2 transaction before the first byte.
 * A request naming an object or frame the kept manifest lacks rebuilds it (no worse than building per request);
 * the service forgets a manifest whose source or current study facts no longer match. */
export class ManifestReuse {
  private readonly kept = new Map<string, ImageManifest>();
  private readonly building = new Map<string, Promise<ImageManifest>>();

  /** limit: studies kept per API process (a few readers' current and prior studies at the first hospital). */
  constructor(private readonly limit = 32) {}

  /** `build` reads the catalog with this request's own identity and signal. A build another request started is
   * joined; if it fails for its own requester (aborted, refused) or does not cover this request, this request builds. */
  async manifest(image: ImageRequest, build: () => Promise<ImageManifest>, signal: AbortSignal): Promise<ImageManifest> {
    const kept = this.kept.get(image.studyUid);
    if (kept && covers(kept, image)) { this.keep(image.studyUid, kept); return kept; }
    let joined: Promise<ImageManifest> | undefined;
    // Two joins at most: when the build being joined fails, another waiting request may already have started the next.
    for (let attempt = 0; attempt < 2; attempt++) {
      const pending = this.building.get(image.studyUid);
      if (!pending || pending === joined) break;
      joined = pending;
      try {
        const manifest = await abortable(pending, signal);
        if (covers(manifest, image)) return manifest;
        break;
      } catch (error) {
        if (signal.aborted) throw error;
      }
    }
    signal.throwIfAborted();
    const run = build().then(verifiedManifest);
    this.building.set(image.studyUid, run);
    try {
      const manifest = await run;
      this.keep(image.studyUid, manifest);
      return manifest;
    } finally {
      if (this.building.get(image.studyUid) === run) this.building.delete(image.studyUid);
    }
  }

  forget(studyUid: string, manifest: ImageManifest): void {
    if (this.kept.get(studyUid) === manifest) this.kept.delete(studyUid);
  }

  private keep(studyUid: string, manifest: ImageManifest): void {
    this.kept.delete(studyUid);
    this.kept.set(studyUid, manifest);
    for (const oldest of this.kept.keys()) {
      if (this.kept.size <= this.limit) break;
      this.kept.delete(oldest);
    }
  }
}

/** The same scope prepareDelivery requires: the named series, object (in that series) and frames exist. */
function covers(manifest: ImageManifest, image: ImageRequest): boolean {
  if (manifest.studyUid !== image.studyUid) return false;
  if (image.seriesUid !== null && !manifest.objects.some(o => o.seriesUid === image.seriesUid)) return false;
  if (image.sopInstanceUid === null) return true;
  const object = manifest.objects.find(o => o.sopInstanceUid === image.sopInstanceUid);
  if (!object || object.seriesUid !== image.seriesUid) return false;
  return (image.frames ?? []).every(n => object.frames.some(f => f.number === n));
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    promise.then(value => { signal.removeEventListener('abort', stop); resolve(value); },
      error => { signal.removeEventListener('abort', stop); reject(error); });
  });
}
