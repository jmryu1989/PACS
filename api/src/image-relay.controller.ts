/*
 * MG-08 (D1877(2)): the existing worklist, report and viewer image reads - `/instances/{id}/...` (worklist preview and
 * thumbnails `frames/N/rendered`, report/print `image-uint16`/`image-int16`, strip `preview`, `pdf`, `file`) and the
 * image representations of `/dicom-web/` (WADO-RS frames, rendered, thumbnail, bulk data, whole-object retrieve) - used
 * to go from nginx straight to Orthanc after `auth_request`, which admits a read but cannot see it delivered, so no
 * study delivery record existed for them. nginx now routes them here. The handler runs the same DICOMweb gate
 * (PacsService.authzDicom: institution, StudyAccess, split UID), takes the study delivery's lease - its provide-prepared
 * event durable before any byte (image-delivery-record.ts) - and relays Orthanc's answer unchanged (status, media type,
 * body; the query carries rendering and windowing as before). Descriptions without the image (QIDO, DICOMweb metadata,
 * DICOM tags) are not deliveries of the image and keep the plain gate; the auth_request route refuses every image read
 * (pacs.controller.ts), so an image byte has no unrecorded way out.
 */
import { Controller, ForbiddenException, Get, NotFoundException, Req, Res } from '@nestjs/common';
import { StudyImageDeliveryRecorder } from './image-delivery-record';
import { OrthancService } from './orthanc.service';
import { Caller, PacsService } from './pacs.service';

export const IMAGE_RELAY_SURFACE = 'GET image-relay/*';
const PREFIX = '/api/image-relay';
const UID = '[0-9.]{1,64}';
// QIDO answers and DICOMweb metadata: attributes and BulkDataURIs, never the pixel data itself.
const DICOMWEB_DESCRIPTION = new RegExp(`^/dicom-web/(?:studies|series|instances|studies/${UID}/(?:series|instances|series/${UID}/instances)` +
  `|studies/${UID}(?:/series/${UID}(?:/instances/${UID})?)?/metadata)$`);
// The header reads the print and volume consumers make before their image read: Orthanc's tag dumps leave binary
// values out, and the attachment info is the stored file's size and digest.
const INSTANCE_DESCRIPTION = /^\/instances\/[0-9a-f-]+\/(?:tags|simplified-tags|header|attachments\/dicom\/info)$/;

/**
 * True for a read whose answer carries the stored object's image: pixels, a rendering, an encapsulated document or the
 * whole object. Anything under the two image roots that is not a named description counts, so a representation added
 * later is recorded rather than missed.
 */
export function imageRead(path: string): boolean {
  if (path.startsWith('/instances/')) return !INSTANCE_DESCRIPTION.test(path);
  if (path.startsWith('/dicom-web/')) return !DICOMWEB_DESCRIPTION.test(path);
  return false;
}

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
    await this.pacs.authzDicom(uri, req.method, member(req));
    // HEAD sends no image byte (Node drops the body), so it is no delivery.
    const lease = req.method === 'GET' && imageRead(target.path)
      ? await this.deliveries.admit(req, IMAGE_RELAY_SURFACE, await this.studyOf(target.path)) : null;
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
      await this.orthanc.relay(uri, String(req.headers?.accept ?? '*/*'), res, abort.signal, origin);
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

  /** The gate has just resolved (and cached) the same study; an image read always names it. */
  private async studyOf(path: string): Promise<string> {
    const study = /^\/dicom-web\/studies\/([0-9.]+)(?:\/|$)/.exec(path)?.[1];
    if (study) return study;
    const instance = /^\/instances\/([0-9a-f-]+)(?:\/|$)/.exec(path)?.[1];
    if (instance) return this.orthanc.instanceStudyUid(instance);
    throw new ForbiddenException('열람 권한이 없습니다');
  }
}
