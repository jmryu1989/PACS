/*
 * MG-08 (D1877(2)): the existing worklist, report and viewer image reads - `/instances/{id}/...` (worklist preview and
 * thumbnails `frames/N/rendered`, report/print `image-uint16`/`image-int16`, strip `preview`, `pdf`, `file`) and the
 * image representations of `/dicom-web/` (WADO-RS frames, rendered, thumbnail, bulk data, whole-object retrieve) - used
 * to go from nginx straight to Orthanc after `auth_request`, which admits a read but cannot see it delivered, so no
 * study delivery record existed for them. nginx now routes them here. The handler runs the same DICOMweb gate
 * (PacsService.authzDicom: institution, StudyAccess, split UID), takes the study delivery's lease for the study and
 * patient the gate observed - its provide-prepared event durable before any byte, naming that patient and the archive's
 * revision the recorder read for this lease (image-delivery-record.ts) - and, once the archive still holds them after
 * Orthanc chose its answer, relays that answer unchanged (status, media type,
 * body; the query carries rendering and windowing as before). Descriptions without the image are not deliveries of the
 * image: the instance tag dumps and attachment info relayed here record a 열람 of the study's metadata of their own
 * (StudyImageDeliveryRecorder.describe), durable before their first byte; QIDO and DICOMweb metadata go from nginx to
 * Orthanc behind auth_request and are not recorded. The auth_request route refuses every image read
 * (pacs.controller.ts), so an image byte has no unrecorded way out.
 */
import { Controller, Get, NotFoundException, Req, Res } from '@nestjs/common';
import { archiveRead, RECORDED_STUDY_HEADER, StudyImageDeliveryRecorder } from './image-delivery-record';
import { OrthancService } from './orthanc.service';
import { Caller, PacsService } from './pacs.service';

export const IMAGE_RELAY_SURFACE = 'GET image-relay/*';
const PREFIX = '/api/image-relay';

/** The original path and query nginx appended to the relay prefix; anything but a plain image-root path is no route. */
function relayTarget(url: string): { path: string; query: string } | null {
  if (!url.startsWith(PREFIX + '/')) return null;
  const rest = url.slice(PREFIX.length), mark = rest.indexOf('?');
  const path = mark < 0 ? rest : rest.slice(0, mark), query = mark < 0 ? '' : rest.slice(mark);
  if (!/^\/(?:instances|dicom-web)\/[A-Za-z0-9.,\-/]+$/.test(path) || /\/\/|(?:^|\/)\.\.?(?:\/|$)/.test(path)) return null;
  if (!/^[\x21-\x7e]*$/.test(query)) return null;
  return { path, query };
}

const member = (req: any): Caller => ({ sub: req.sub, actor: req.actor, roles: req.roles ?? [],
  institution: req.institution ?? null, kind: req.kind ?? 'member' });

@Controller('image-relay')
export class ImageRelayController {
  constructor(private readonly pacs: PacsService, private readonly orthanc: OrthancService,
    private readonly deliveries: StudyImageDeliveryRecorder) {}

  @Get('*')
  async read(@Req() req: any, @Res() res: any) {
    const target = relayTarget(String(req.originalUrl ?? req.url ?? ''));
    if (!target) throw new NotFoundException('영상 경로가 올바르지 않습니다');
    const uri = target.path + target.query;
    const admitted = await this.pacs.authzDicom(uri, req.method, member(req));
    // A HEAD or a description is no delivery (image-delivery-record.ts lease()); an instance description is a 열람 of
    // the study's metadata, recorded apart from the deliveries (describe()).
    const lease = await this.deliveries.lease(req, IMAGE_RELAY_SURFACE, target.path, () => archiveRead(admitted));
    const described = lease ? null : await this.deliveries.describe(req, IMAGE_RELAY_SURFACE, target.path, () => archiveRead(admitted));
    if (lease) res.setHeader(RECORDED_STUDY_HEADER, admitted!.studyUid);
    const selected = lease ? () => lease.confirm() : described ? () => described.confirm() : undefined;
    const abort = new AbortController();
    const stop = () => { if (!res.writableFinished) abort.abort(); };
    let relayed = false;
    const closed = new Promise<void>(resolve => {
      if (res.destroyed || res.closed) resolve(); else res.once('close', () => resolve());
    });
    req.once('aborted', stop);
    res.once('close', stop);
    // nginx sets both forwarded headers on every proxied request (server level); the relay validates their shape.
    const first = (name: string) => String(req.headers?.[name] ?? '').split(',')[0].trim();
    const origin = `${first('x-forwarded-proto')}://${first('x-forwarded-host')}`;
    try {
      // Orthanc selects what it answers when the request reaches it, after the lease read the study: the answer is
      // copied only once the archive still holds the patient and revision the record names (C6/C7, I3).
      await this.orthanc.relay(uri, String(req.headers?.accept ?? '*/*'), res, abort.signal, origin, selected);
      relayed = true;
    } catch (error) {
      // After the headers a JSON error cannot follow; cutting the connection is the truthful end of a partial image.
      if (res.headersSent) { res.destroy(); return; }
      throw error;
    } finally {
      req.off('aborted', stop);
      // A served image is a relayed success answer the client received in full; Orthanc's error answers are not.
      if (lease) void closed.then(() => lease.release(relayed && res.writableFinished === true && res.statusCode >= 200 && res.statusCode < 300));
    }
  }
}
