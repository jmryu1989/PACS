import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { ClinicalContextSource, ClinicalRequestFacts, StudyScope } from '../emr-clinical/runtime';
import type { StudyFacts } from '../emr-clinical/contract';
import { refuse } from '../emr-contract/validation';
import type { EmrRecordTransaction } from '../emr-runtime/record-port';
import { ImageManifest, verifiedManifest } from './manifest';
import type { DeliveryContext, ImageRequest } from './contract';

export interface CurrentImageFacts extends ClinicalRequestFacts {
  accountGeneration: number;
  provision: DeliveryContext['provision'];
}

/** Module A supplies its current request/patient/source readers here. Catalog
 * reads may use the image store before the short B2 transaction; current() must
 * lock current identity, institution, patient link and StudyAccess on tx and
 * compare the selected source manifest. Browser fields are never these facts.
 * recheck() is the per-response check of a study delivery that current() opened (delivery.ts): the same identity,
 * institution scope, StudyAccess and provision facts on tx (a bounded transaction of E's own check pool, check-db.ts),
 * without D's study read (the archive QIDO). The archive's current study identity is still compared on
 * every response, by the source:
 * the same study read D makes (OrthancService.studyPatientIdentity: no resource, two patient resources, the one
 * patient) and the selected object's own header, both against the manifest's patient (orthanc.service.ts, stream.ts,
 * R244-GPT-01: a correction of the object, or a second patient's resource arriving under the UID). D's patient link is
 * made of the managing institution and that PatientID, so the reads together cover what current() compares; a
 * replaced object is refused by the digests. */
export abstract class ImageContextSource {
  abstract manifest(request: object, image: ImageRequest, signal: AbortSignal): Promise<ImageManifest>;
  abstract current(tx: EmrRecordTransaction, request: object, manifest: ImageManifest,
    at: string): Promise<CurrentImageFacts>;
  abstract recheck(tx: EmrRecordTransaction, request: object, manifest: ImageManifest,
    at: string): Promise<CurrentImageFacts>;
}

export interface ImageCatalogSource {
  manifest(request: object, image: ImageRequest, signal: AbortSignal): Promise<ImageManifest>;
  delivery(tx: EmrRecordTransaction, request: object, facts: ClinicalRequestFacts,
    study: StudyFacts, at: string): Promise<Pick<CurrentImageFacts, 'accountGeneration' | 'provision'>>;
}

/** D's existing current context owns identity/member/session and StudyAccess
 * locks. E binds its selected source to that same current study/patient, then
 * consumes the server's existing provision basis and account generation. */
export class ProductionImageContext extends ImageContextSource {
  constructor(private readonly clinical: ClinicalContextSource, private readonly catalog: ImageCatalogSource) { super(); }
  async manifest(request: object, image: ImageRequest, signal: AbortSignal): Promise<ImageManifest> {
    return verifiedManifest(await this.catalog.manifest(request, image, signal));
  }
  async current(tx: EmrRecordTransaction, request: object, manifest: ImageManifest, at: string): Promise<CurrentImageFacts> {
    const facts = await this.clinical.facts(tx, request);
    const study = await this.clinical.study(tx, request, manifest.studyUid);
    if (facts.actor.kind !== 'member' || study.studyId !== manifest.studyUid ||
        study.managingInstitutionId !== manifest.managingInstitution ||
        study.patient.linkId !== manifest.patient.linkId || study.patient.patientId !== manifest.patient.patientId ||
        study.patient.assigningAuthority !== manifest.patient.assigningAuthority) refuse('ImageCurrentStudyChanged');
    return { ...facts, ...await this.catalog.delivery(tx, request, facts, study, at) };
  }
  /** D's scope read (institution, tele scope, StudyAccess) instead of its study read: the archive's study identity
   * (an Orthanc QIDO) is not read inside the transaction; the source reads it for this response, with the object's
   * current PatientID, and compares both with the manifest's (orthanc.service.ts, stream.ts). */
  async recheck(tx: EmrRecordTransaction, request: object, manifest: ImageManifest, at: string): Promise<CurrentImageFacts> {
    const facts = await this.clinical.facts(tx, request);
    const scope = await this.clinical.scope(tx, request, manifest.studyUid);
    if (facts.actor.kind !== 'member' || scope.studyId !== manifest.studyUid ||
        scope.managingInstitutionId !== manifest.managingInstitution) refuse('ImageCurrentStudyChanged');
    return { ...facts, ...await this.catalog.delivery(tx, request, facts, { ...scope, patient: manifest.patient }, at) };
  }
}

/** REQUEST_FACTS #211 has not landed on the D-online base. An unavailable
 * authoritative reader must not be replaced by client identity or guessed
 * patient/source/decoder facts. This binding is replaced at Module A assembly. */
@Injectable()
export class ModuleAImageContextPending implements ClinicalContextSource, ImageCatalogSource {
  private unavailable(): never {
    throw new ServiceUnavailableException({ code: 'IMAGE_CONTEXT_UNAVAILABLE',
      message: '영상의 현재 접근 권한과 원본 정보를 확인할 수 없습니다' });
  }
  async manifest(_request: object, _image: ImageRequest, _signal: AbortSignal): Promise<ImageManifest> { return this.unavailable(); }
  async facts(_tx: EmrRecordTransaction, _request: object): Promise<ClinicalRequestFacts> { return this.unavailable(); }
  async study(_tx: EmrRecordTransaction, _request: object, _studyId: string): Promise<StudyFacts> { return this.unavailable(); }
  // #219 split the study's institutional scope from its patient identity (D's reads must not depend on the archive);
  // this pending binding has no authoritative reader for either, so the scope is as unavailable as the study.
  async scope(_tx: EmrRecordTransaction, _request: object, _studyId: string): Promise<StudyScope> { return this.unavailable(); }
  async delivery(_tx: EmrRecordTransaction, _request: object, _facts: ClinicalRequestFacts,
    _study: StudyFacts, _at: string): Promise<Pick<CurrentImageFacts, 'accountGeneration' | 'provision'>> { return this.unavailable(); }
}
