/*
 * MG-LOADING: the viewer's WADO-RS frame reads and series-strip previews, routed here by nginx (proxy/nginx.conf.template)
 * instead of straight to Orthanc. The DICOMweb gate is the same one nginx's auth_request runs for every other image
 * read (PacsService.authzDicom): institution, StudyAccess and the split-UID check, with the viewer's session binding
 * already enforced by the guard. The study delivery's 열람 record (image-delivery-record.ts, D1877) is durable before
 * any byte; bytes are then served by DicomFrameService (direct range read or Orthanc relay). The recorder is the one the
 * image relay uses, so the frames, previews and relayed reads of one opening share one pair.
 */
import { BadRequestException, Controller, Get, Param, Req, Res } from '@nestjs/common';
import { DicomFrameService } from './dicom-frame.service';
import { FETCH_USE, PRELOAD_USE, RECORDED_STUDY_HEADER, StudyImageDeliveryRecorder, readUse } from './image-delivery-record';
import type { DeliveryLease, DeliveryUse } from './image-delivery-record';
import { OrthancService } from './orthanc.service';
import { Caller, PacsService } from './pacs.service';
import { parseFrameList } from './dicom-frame-layout';

const member = (req: any): Caller => ({ sub: req.sub, actor: req.actor, roles: req.roles ?? [],
  institution: req.institution ?? null, kind: req.kind ?? 'member' });
const UID = /^[0-9.]{1,64}$/;
const ORTHANC_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{8}){4}$/;
/** The surface of the delivery's access events when one of these two routes opens it. */
export const FRAMES_SURFACE = 'GET dicom-web/studies/:study/series/:series/instances/:sop/frames/:frames';
export const PREVIEW_SURFACE = 'GET instances/:id/preview';
/** The archive's revision of the study a preload read was served under (see `DicomFrameController.revision`). */
export const REVISION_HEADER = 'X-KIN-Study-Revision';

/** `store`: the preload store's read (stored form, revision); `check`: the viewer's opening read of a held study (revision). */
function preloadMode(req: any): 'store' | 'check' | null {
  const value = String(req.headers?.['x-kin-preload'] ?? '').trim().toLowerCase();
  return value === 'store' || value === 'check' ? value : null;
}

/**
 * The delivery a frame read joins (image-delivery-record.ts `DeliveryUse`): the preload store's read is the preload's
 * transfer; every other read - the viewer's check read included - belongs to the opening it names, if it names one.
 */
function frameUse(req: any, preload: 'store' | 'check' | null): DeliveryUse {
  return preload === 'store' ? PRELOAD_USE : readUse(req);
}

function requestOrigin(req: any): string {
  const proto = String(req.headers?.['x-forwarded-proto'] ?? req.protocol ?? 'https').split(',')[0].trim();
  const host = String(req.headers?.['x-forwarded-host'] ?? req.headers?.host ?? '').split(',')[0].trim();
  return /^https?$/.test(proto) && /^[A-Za-z0-9.:\-\[\]]{1,255}$/.test(host) ? `${proto}://${host}` : (process.env.PUBLIC_ORIGIN ?? '').replace(/\/$/, '');
}

/**
 * The request's lifetime as a signal: aborted when the client goes away before the response finished (the viewer page
 * closed, a pane re-targeted). The service passes it to the index lookups and to a relayed Orthanc read, so a doctor
 * closing the viewer does not leave an Orthanc whole-file read running for nobody. The response's `close` - which
 * follows a finished response as well as one cut short - also ends the delivery lease. One listener does both: the
 * gzip pipeline already puts six of Node's own close listeners on the response, and an eleventh is a leak warning.
 *
 * The lease learns whether an image was served, not whether the socket finished: a service that failed (its error
 * answer is written after it, by the exception filter, and finishes the socket too) or a relayed non-success answer
 * from Orthanc is no image (review MG-10). Both facts - the service's outcome and the response's close - may arrive
 * in either order, so the lease is released when the second one does. A HEAD has no lease (see `admit` below).
 */
function lifetime(req: any, res: any, lease: DeliveryLease | null, work: (signal: AbortSignal) => Promise<void>): Promise<void> {
  const abort = new AbortController();
  let outcome: boolean | null = null, closed = false;
  const release = () => { if (lease && closed && outcome !== null) lease.release(outcome && res.writableFinished === true && res.statusCode < 400); };
  const stop = () => { if (!res.writableFinished) abort.abort(); };
  const onClose = () => { stop(); closed = true; release(); };
  req.once?.('aborted', stop);
  if (res.destroyed || res.closed) onClose(); else res.once?.('close', onClose);
  return work(abort.signal).then(() => { outcome = true; }, error => { outcome = false; throw error; })
    .finally(() => { req.off?.('aborted', stop); release(); });
}

@Controller()
export class DicomFrameController {
  constructor(private readonly frames: DicomFrameService, private readonly pacs: PacsService,
    private readonly orthanc: OrthancService, private readonly deliveries: StudyImageDeliveryRecorder) {}

  /**
   * HEAD sends no image byte (Node drops the body), so it is no delivery, as in the image relay: it neither opens the
   * study's delivery nor counts as an image served in it, where a 200 HEAD would turn a delivery whose relayed reads
   * all failed into a provided one (review INT-01).
   */
  private admit(req: any, surface: string, study: () => Promise<string>, use: DeliveryUse = FETCH_USE): Promise<DeliveryLease | null> {
    return req.method === 'GET' ? study().then(uid => this.deliveries.admit(req, surface, uid, use)) : Promise.resolve(null);
  }

  @Get('dicom-web/studies/:study/series/:series/instances/:sop/frames/:frames')
  async read(@Param('study') study: string, @Param('series') series: string, @Param('sop') sop: string,
      @Param('frames') frames: string, @Req() req: any, @Res() res: any) {
    if (![study, series, sop].every(uid => UID.test(uid))) throw new BadRequestException('영상 식별자가 올바르지 않습니다');
    const list = parseFrameList(frames);
    if (!list) throw new BadRequestException('프레임 번호가 올바르지 않습니다');
    const uri = `/dicom-web/studies/${study}/series/${series}/instances/${sop}/frames/${frames}`;
    await this.pacs.authzDicom(uri, 'GET', member(req));
    const preload = preloadMode(req);
    if (preload) await this.revision(study, preload, res);
    const lease = await this.admit(req, FRAMES_SURFACE, async () => study, frameUse(req, preload));
    await lifetime(req, res, lease, signal => this.frames.serveFrames({ studyUid: study, seriesUid: series, sopUid: sop, frames: list,
      accept: req.headers?.accept, acceptEncoding: req.headers?.['accept-encoding'], head: req.method === 'HEAD',
      origin: requestOrigin(req), stored: preload === 'store' }, res, signal));
  }

  /**
   * D1880 memory-only preload. A frame the preload store holds reaches the screen without passing this gate again, so
   * the store keeps the archive's revision of the study its bytes were read under, and the viewer's first read of a
   * held study is a live read (`check`) that answers the current one; a different revision - an object stored into or
   * removed from the study since, Orthanc's LastUpdate - discards the held bytes. Both reads pass the gate above as any
   * other frame; the store's reads are a preload delivery of their own (a transfer, never an opening), and the `check`
   * read names the viewer's opening, so it records that opening's 열람 (D1877, D1880) before its first byte even when
   * every later frame comes from memory and a preload of the study was delivered moments before. A stored read with no revision is
   * refused (nothing to check it against later); a check read without one is served, and the viewer, seeing no match,
   * stays live.
   */
  private async revision(study: string, mode: 'store' | 'check', res: any): Promise<void> {
    try {
      const { id, lastUpdate } = await this.orthanc.studyRevision(study);
      res.setHeader(REVISION_HEADER, `orthanc-study:${id}@${lastUpdate}`);
    } catch (error) { if (mode === 'store') throw error; }
  }

  @Get('instances/:id/preview')
  async preview(@Param('id') id: string, @Req() req: any, @Res() res: any) {
    if (!ORTHANC_ID.test(id)) throw new BadRequestException('영상 식별자가 올바르지 않습니다');
    await this.pacs.authzDicom(`/instances/${id}/preview`, 'GET', member(req));
    // The gate just resolved (and cached) the object's study; the preview is a read of that study's delivery.
    let study = '';
    const lease = await this.admit(req, PREVIEW_SURFACE, async () => (study = await this.orthanc.instanceStudyUid(id)), readUse(req));
    if (lease) res.setHeader(RECORDED_STUDY_HEADER, study);
    await lifetime(req, res, lease, signal => this.frames.servePreview(id, res, signal));
  }
}
