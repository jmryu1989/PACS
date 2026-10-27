/*
 * MG-LOADING: the viewer's WADO-RS frame reads and series-strip previews, routed here by nginx (proxy/nginx.conf.template)
 * instead of straight to Orthanc. The DICOMweb gate is the same one nginx's auth_request runs for every other image
 * read (PacsService.authzDicom): institution, StudyAccess and the split-UID check, with the viewer's session binding
 * already enforced by the guard. Bytes are served by DicomFrameService (direct range read or Orthanc relay).
 */
import { BadRequestException, Controller, Get, Param, Req, Res } from '@nestjs/common';
import { DicomFrameService } from './dicom-frame.service';
import { Caller, PacsService } from './pacs.service';
import { parseFrameList } from './dicom-frame-layout';

const member = (req: any): Caller => ({ sub: req.sub, actor: req.actor, roles: req.roles ?? [],
  institution: req.institution ?? null, kind: req.kind ?? 'member' });
const UID = /^[0-9.]{1,64}$/;
const ORTHANC_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{8}){4}$/;

function requestOrigin(req: any): string {
  const proto = String(req.headers?.['x-forwarded-proto'] ?? req.protocol ?? 'https').split(',')[0].trim();
  const host = String(req.headers?.['x-forwarded-host'] ?? req.headers?.host ?? '').split(',')[0].trim();
  return /^https?$/.test(proto) && /^[A-Za-z0-9.:\-\[\]]{1,255}$/.test(host) ? `${proto}://${host}` : (process.env.PUBLIC_ORIGIN ?? '').replace(/\/$/, '');
}

/**
 * The request's lifetime as a signal: aborted when the client goes away before the response finished (the viewer page
 * closed, a pane re-targeted). The service passes it to the index lookups and to a relayed Orthanc read, so a doctor
 * closing the viewer does not leave an Orthanc whole-file read running for nobody.
 */
function lifetime(req: any, res: any, work: (signal: AbortSignal) => Promise<void>): Promise<void> {
  const abort = new AbortController();
  const stop = () => { if (!res.writableFinished) abort.abort(); };
  req.once?.('aborted', stop); res.once?.('close', stop);
  return work(abort.signal).finally(() => { req.off?.('aborted', stop); res.off?.('close', stop); });
}

@Controller()
export class DicomFrameController {
  constructor(private readonly frames: DicomFrameService, private readonly pacs: PacsService) {}

  @Get('dicom-web/studies/:study/series/:series/instances/:sop/frames/:frames')
  async read(@Param('study') study: string, @Param('series') series: string, @Param('sop') sop: string,
      @Param('frames') frames: string, @Req() req: any, @Res() res: any) {
    if (![study, series, sop].every(uid => UID.test(uid))) throw new BadRequestException('영상 식별자가 올바르지 않습니다');
    const list = parseFrameList(frames);
    if (!list) throw new BadRequestException('프레임 번호가 올바르지 않습니다');
    const uri = `/dicom-web/studies/${study}/series/${series}/instances/${sop}/frames/${frames}`;
    await this.pacs.authzDicom(uri, 'GET', member(req));
    await lifetime(req, res, signal => this.frames.serveFrames({ studyUid: study, seriesUid: series, sopUid: sop, frames: list,
      accept: req.headers?.accept, acceptEncoding: req.headers?.['accept-encoding'], head: req.method === 'HEAD',
      origin: requestOrigin(req) }, res, signal));
  }

  @Get('instances/:id/preview')
  async preview(@Param('id') id: string, @Req() req: any, @Res() res: any) {
    if (!ORTHANC_ID.test(id)) throw new BadRequestException('영상 식별자가 올바르지 않습니다');
    await this.pacs.authzDicom(`/instances/${id}/preview`, 'GET', member(req));
    await lifetime(req, res, signal => this.frames.servePreview(id, res, signal));
  }
}
