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
import { StudyImageDeliveryRecorder } from './image-delivery-record';
import type { DeliveryLease } from './image-delivery-record';
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
 * in either order, so the lease is released when the second one does.
 */
function lifetime(req: any, res: any, lease: DeliveryLease, work: (signal: AbortSignal) => Promise<void>): Promise<void> {
  const abort = new AbortController();
  let outcome: boolean | null = null, closed = false;
  const release = () => { if (closed && outcome !== null) lease.release(outcome && res.writableFinished === true && res.statusCode < 400); };
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

  @Get('dicom-web/studies/:study/series/:series/instances/:sop/frames/:frames')
  async read(@Param('study') study: string, @Param('series') series: string, @Param('sop') sop: string,
      @Param('frames') frames: string, @Req() req: any, @Res() res: any) {
    if (![study, series, sop].every(uid => UID.test(uid))) throw new BadRequestException('영상 식별자가 올바르지 않습니다');
    const list = parseFrameList(frames);
    if (!list) throw new BadRequestException('프레임 번호가 올바르지 않습니다');
    const uri = `/dicom-web/studies/${study}/series/${series}/instances/${sop}/frames/${frames}`;
    await this.pacs.authzDicom(uri, 'GET', member(req));
    const lease = await this.deliveries.admit(req, FRAMES_SURFACE, study);
    await lifetime(req, res, lease, signal => this.frames.serveFrames({ studyUid: study, seriesUid: series, sopUid: sop, frames: list,
      accept: req.headers?.accept, acceptEncoding: req.headers?.['accept-encoding'], head: req.method === 'HEAD',
      origin: requestOrigin(req) }, res, signal));
  }

  @Get('instances/:id/preview')
  async preview(@Param('id') id: string, @Req() req: any, @Res() res: any) {
    if (!ORTHANC_ID.test(id)) throw new BadRequestException('영상 식별자가 올바르지 않습니다');
    await this.pacs.authzDicom(`/instances/${id}/preview`, 'GET', member(req));
    // The gate just resolved (and cached) the object's study; the preview is a read of that study's delivery.
    const study = await this.orthanc.instanceStudyUid(id);
    const lease = await this.deliveries.admit(req, PREVIEW_SURFACE, study);
    await lifetime(req, res, lease, signal => this.frames.servePreview(id, res, signal));
  }
}
