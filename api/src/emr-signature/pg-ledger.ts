import { newAuditLinkId, parseAccessEvent } from '../emr-contract/access-event';
import type { AccessEventV1 } from '../emr-contract/access-event';
import type { EmrRecordPort } from '../emr-runtime/record-port';
import type { LedgerPort, SigningEvent } from './server-contract';

const known = <T>(value: T) => ({ status: 'known' as const, value });
const notRecord = { status: 'not-applicable' as const, reason: 'non-record-target' as const };

/** Key custody is an administrative fact; only clinical changes enter both
 * statutory streams. No new transaction/outcome authority is introduced. */
export function signingAccessEvent(event: SigningEvent): Readonly<AccessEventV1> {
  const key = event.task.startsWith('key-'), read = event.task === 'view';
  return parseAccessEvent({ formatVersion: 1,
    surface: key ? 'server:doctor-key-management' : read ? 'GET studies/:uid/report/versions' : 'POST studies/:uid/report/commit',
    eventId: event.eventId, userId: known(event.actor), rolesAtTime: known(event.roles),
    actingInstitution: known(event.institutionId), managingInstitution: known(event.managingInstitutionId),
    occurredAt: event.at, trustedProxyIp: event.ingress.ip, cause: 'user-view',
    context: { basis: key ? 'out-of-context' : 'worklist', studyId: key ? null : event.studyId,
      relatedStudyId: null, reason: null }, executor: 'member',
    targets: [{ kind: key ? 'identity-access' : 'report-version',
      patientLinkSnapshot: key ? notRecord : known(event.patient), studyId: key ? notRecord : known(event.studyId),
      recordId: known(key ? event.doctorId : event.recordId), versionId: known(key ? event.kid : event.versionId) }],
    action: key ? 'modify' : read ? 'provide-prepared' : event.task,
    result: read ? 'prepared' : 'succeeded', requestId: event.ingress.requestId,
    auditLinkId: newAuditLinkId(), relatedEventId: null }) as Readonly<AccessEventV1>;
}

export function pgSigningLedger(port: EmrRecordPort): LedgerPort {
  return { async transactionWithRecords(body) {
    const work = port.begin();
    try {
      return await work.transactionWithRecords((tx, record) => body(tx,
        (event, effect) => record(signingAccessEvent(event), effect)));
    } finally { work.end(); }
  } };
}
