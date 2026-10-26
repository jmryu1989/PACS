import { randomUUID } from 'node:crypto';
import { AccessEventV1, newAuditLinkId, parseAccessEvent } from '../emr-contract/access-event';
import { freeze, refuse } from '../emr-contract/validation';
import type { ClinicalRecord } from './contract';
import { planClinicalRead, provideClinicalRead } from './records';
import type { ClinicalRuntimeParts } from './runtime';

const known = <T>(value: T) => ({ status: 'known' as const, value });

/** The body and target manifest come from the same stored versions. A later
 * change to the head cannot replace the body after its provide event commits. */
export async function readOnlineClinicalRecord(parts: ClinicalRuntimeParts, request: object,
  record: ClinicalRecord, recordId: string, scope: 'current' | 'history') {
  const work = parts.records.begin();
  try {
    const snapshot = await parts.store.transaction(async tx => {
      const facts = await parts.context.facts(tx, request);
      const unit = await parts.store.unit(tx, record, recordId);
      if (!unit) refuse('NotFound');
      const study = await parts.context.study(tx, request, unit.studyId);
      const plan = planClinicalRead({ actor: facts.actor, unit, scope, study });
      const wanted = new Set(plan.versions.map(v => v.versionId));
      const versions = (await parts.store.versions(tx, record, recordId)).filter(v => wanted.has(v.plan.version.versionId));
      if (versions.length !== wanted.size) refuse('ClinicalResultMismatch');
      for (const v of versions) if (v.plan.signing) {
        if (!v.signature) refuse('SignatureRequired');
        parts.signer.verify(v.signature, v.plan.signing);
      }
      return { facts, unit, plan, signatures: versions.map(v => ({ versionId: v.plan.version.versionId, signature: v.signature })) };
    });
    const { facts, unit, plan } = snapshot;
    const event = parseAccessEvent({ formatVersion: 1, surface: plan.route, eventId: randomUUID(),
      userId: known(facts.actor.identity), rolesAtTime: known(facts.actor.roles), actingInstitution: known(facts.actor.institutionId),
      managingInstitution: known(unit.managingInstitutionId), occurredAt: new Date().toISOString(), trustedProxyIp: facts.ip,
      cause: 'user-view', context: { basis: 'worklist', studyId: unit.studyId, relatedStudyId: null, reason: null }, executor: 'member',
      targets: plan.targets, action: 'provide-prepared', result: 'prepared', requestId: facts.requestId,
      auditLinkId: newAuditLinkId(), relatedEventId: null } as AccessEventV1);
    return await provideClinicalRead(work, event, plan, async (bodies, receipt) => {
      await parts.store.transaction(async tx => {
        const current = await parts.context.facts(tx, request);
        const study = await parts.context.study(tx, request, unit.studyId);
        if (current.actor.identity.id !== facts.actor.identity.id || current.actor.institutionId !== facts.actor.institutionId) refuse('OwnerChanged');
        planClinicalRead({ actor: current.actor, unit, scope, study });
      });
      return freeze({ record, recordId, studyId: unit.studyId, bodies, signatures: snapshot.signatures,
        access: { eventId: receipt.eventId, durableAt: receipt.durableAt } });
    });
  } finally { work.end(); }
}
