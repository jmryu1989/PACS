import { Inject, Injectable, ServiceUnavailableException, BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { newAuditLinkId, parseAccessEvent } from '../emr-contract/access-event';
import { refuse } from '../emr-contract/validation';
import { EMR_RECORD_PORT, EmrRecordPort } from '../emr-runtime/record-port';
import { OrthancService } from '../orthanc.service';
import { PrismaService } from '../prisma.service';
import { parseImageRequest, prepareDelivery } from './contract';
import { ImageContextSource } from './context';
import { verifiedManifest } from './manifest';
import { PgImageEvidenceStore } from './store';
import { sendOnlineImage } from './stream';

const known = <T>(value: T) => ({ status: 'known' as const, value });

@Injectable()
export class OnlineImageService {
  constructor(@Inject(EMR_RECORD_PORT) private readonly records: EmrRecordPort,
    private readonly context: ImageContextSource, private readonly db: PrismaService,
    private readonly orthanc: OrthancService) {}

  async send(request: any, response: ServerResponse, target: string) {
    let image: ReturnType<typeof parseImageRequest>;
    try { image = parseImageRequest(request.method, target); }
    catch { throw new BadRequestException('영상 요청 경로를 확인하세요'); }
    if (!process.env.KIN_EMR_STATE_DIR) throw new ServiceUnavailableException('영상 임시 저장소를 확인할 수 없습니다');
    const abort = new AbortController();
    const stop = () => { if (!response.writableFinished) abort.abort(); };
    request.once('aborted', stop); response.once('close', stop);
    try {
      const manifest = verifiedManifest(await this.context.manifest(request, image, abort.signal));
      const at = new Date().toISOString(), eventId = randomUUID();
      const work = this.records.begin();
      let facts: Awaited<ReturnType<ImageContextSource['current']>>;
      try { facts = await work.transactionWithRecords(tx => this.context.current(tx, request, manifest, at)); }
      finally { work.end(); }
      const prepared = prepareDelivery(manifest, image, { eventId, at, cause: 'background-fetch', opening: null,
        authorization: { studyUid: image.studyUid, institution: facts.actor.institutionId,
          accountGeneration: facts.accountGeneration }, provision: facts.provision });
      const targets = [...new Map(prepared.units.map(unit => [unit.sopInstanceUid ?? manifest.studyUid, unit])).entries()];
      const event = parseAccessEvent({ formatVersion: 1, surface: `${image.method} images/dicom-web`, eventId,
        userId: known(facts.actor.identity), rolesAtTime: known(facts.actor.roles), actingInstitution: known(facts.actor.institutionId),
        managingInstitution: known(manifest.managingInstitution), occurredAt: at, trustedProxyIp: facts.ip,
        cause: prepared.cause, context: { basis: 'background-fetch', studyId: null, relatedStudyId: null, reason: null },
        executor: 'member', targets: targets.map(([id, unit]) => ({ kind: unit.recordKind,
          patientLinkSnapshot: known(manifest.patient), studyId: known(manifest.studyUid), recordId: known(id), versionId: known(manifest.sha256) })),
        action: 'provide-prepared', result: 'prepared', requestId: facts.requestId, auditLinkId: newAuditLinkId(), relatedEventId: null });
      const stagingDirectory = join(process.env.KIN_EMR_STATE_DIR, 'image-staging');
      await mkdir(stagingDirectory, { recursive: true });
      return await sendOnlineImage({ records: this.records, evidence: new PgImageEvidenceStore(this.db),
        source: this.orthanc.imageSource(), stagingDirectory,
        authorize: async (tx, _event, selected) => {
          const current = await this.context.current(tx, request, selected, new Date().toISOString());
          if (current.actor.identity.id !== facts.actor.identity.id || current.actor.identity.issuer !== facts.actor.identity.issuer ||
              current.actor.identity.subject !== facts.actor.identity.subject ||
              current.actor.institutionId !== facts.actor.institutionId || current.accountGeneration !== facts.accountGeneration ||
              current.actor.roles.length !== facts.actor.roles.length || current.actor.roles.some(role => !facts.actor.roles.includes(role)) ||
              !current.provision.deliverable || current.provision.studyUid !== selected.studyUid ||
              current.provision.managingInstitution !== selected.managingInstitution || current.provision.recipient !== facts.provision.recipient ||
              current.provision.relation !== facts.provision.relation || current.provision.basisId !== facts.provision.basisId ||
              current.provision.agreementId !== facts.provision.agreementId) refuse('ImageAuthorityChanged');
        } }, { manifest, prepared, event, response, signal: abort.signal, range: request.headers.range });
    } finally { request.off('aborted', stop); response.off('close', stop); }
  }
}
