import type { ClinicalContextSource, ClinicalRequestFacts } from '../emr-clinical/runtime';
import type { StudyFacts } from '../emr-clinical/contract';
import { refuse } from '../emr-contract/validation';
import type { EmrRecordTransaction } from '../emr-runtime/record-port';
import { ImageManifest, verifiedManifest } from './manifest';
import type { DeliveryContext, ImageRequest } from './contract';

export interface CurrentImageFacts extends ClinicalRequestFacts {
  accountGeneration: number;
  provision: DeliveryContext['provision'];
}
export type ImageProvision = Pick<CurrentImageFacts, 'accountGeneration' | 'provision'>;

/** Module A supplies its current request/patient/source readers here. Browser fields are never these facts.
 * A response that delivers an image decides on the current facts its study delivery lease read once, after the
 * archive's revision (image-delivery-record.ts current(): identity, institution scope, StudyAccess and D's current
 * study, on one bounded transaction of the image check pool, check-db.ts); provision() decides E's provision basis and
 * account generation from those facts on that same transaction, so E does not decide them again (R244-GPT-FIX10-02).
 * recheck() is the current access check of a response that has no lease (a HEAD): identity, institution scope,
 * StudyAccess and provision facts on tx, without D's study read (the archive QIDO). The archive's current study
 * identity is still compared on every response, by the source: the same study read D makes
 * (OrthancService.studyPatientIdentity: no resource, two patient resources, the one patient) and the selected object's
 * own header, both against the manifest's patient (orthanc.service.ts, stream.ts, R244-GPT-01: a correction of the
 * object, or a second patient's resource arriving under the UID). D's patient link is made of the managing institution
 * and that PatientID, so these reads cover the patient comparison; a replaced object is refused by the digests. */
export abstract class ImageContextSource {
  abstract manifest(request: object, image: ImageRequest, signal: AbortSignal): Promise<ImageManifest>;
  abstract recheck(tx: EmrRecordTransaction, request: object, manifest: ImageManifest,
    at: string): Promise<CurrentImageFacts>;
  abstract provision(tx: EmrRecordTransaction, request: object,
    current: { at: string; facts: ClinicalRequestFacts; study: StudyFacts }): Promise<ImageProvision>;
}

export interface ImageCatalogSource {
  manifest(request: object, image: ImageRequest, signal: AbortSignal): Promise<ImageManifest>;
  delivery(tx: EmrRecordTransaction, request: object, facts: ClinicalRequestFacts,
    study: StudyFacts, at: string): Promise<ImageProvision>;
}

/** D's existing current context owns identity/member/session and StudyAccess
 * locks. E binds its selected source to that same current study/patient, then
 * consumes the server's existing provision basis and account generation. */
export class ProductionImageContext extends ImageContextSource {
  constructor(private readonly clinical: ClinicalContextSource, private readonly catalog: ImageCatalogSource) { super(); }
  async manifest(request: object, image: ImageRequest, signal: AbortSignal): Promise<ImageManifest> {
    return verifiedManifest(await this.catalog.manifest(request, image, signal));
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
  /** The lease already refused a study whose current patient link - managing institution included - is not the
   * manifest's (image-delivery-record.ts current()). */
  async provision(tx: EmrRecordTransaction, request: object,
    { at, facts, study }: { at: string; facts: ClinicalRequestFacts; study: StudyFacts }): Promise<ImageProvision> {
    return this.catalog.delivery(tx, request, facts, study, at);
  }
}
