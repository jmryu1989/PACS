import type { RequestIdentityPort } from '../emr-signature/server-contract';
import { refuse } from '../emr-contract/validation';
import type { ClinicalRouteSources } from './routes';
import type { EmrRecordPort } from '../emr-runtime/record-port';

/** Parties are immutable server identities. Finding copies must be resolved by
 * their owning source reader; request JSON is never a verified attachment. */
export function clinicalRouteSources(identity: RequestIdentityPort, records: EmrRecordPort, findings?: ClinicalRouteSources): ClinicalRouteSources {
  return async (tx, request, write) => {
    if (write.surface.startsWith('finding.')) {
      if (!findings) refuse('FindingSourceReaderUnavailable');
      return findings(tx, request, write);
    }
    const current = await identity.resolve(tx, request);
    const body = write.body as any;
    const party = async (subject: string) => {
      const work = records.begin();
      try {
        // Allocation/consultation recipients need their immutable identity,
        // not a signing registration. The owning service checks eligibility.
        return await work.resolveIdentity(tx, current.actor.identity.issuer, subject);
      } finally { work.end(); }
    };
    return { content: null, attachments: [], navigation: [],
      recipientId: write.surface === 'consultation.create' ? await party(body.recipientSub) : null,
      readerId: write.surface === 'assignment.write' && body.readerSub ? await party(body.readerSub.toLowerCase()) : null,
      workContext: null, projection: null };
  };
}
