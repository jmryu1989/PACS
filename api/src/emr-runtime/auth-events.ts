import { randomUUID } from 'node:crypto';
import type { AuthAccessEventV2, AuthEndCause, AuthFailureCause, EvidenceFactV2, ImmutableIdentity, ReauthenticationTrigger } from '../emr-contract/access-event';
import { AUTH_FAILURE_CAUSES } from '../emr-contract/access-event';
import type { EmrRecordPort } from './record-port';
import { knownIdentity, verifiedIdentityClaims } from './contract';

export type SessionRecordIdentity = Extract<EvidenceFactV2<ImmutableIdentity>, { status: 'known' }>
  | { status: 'unresolved'; reason: 'not-resolved' };

/** Express supplies its matched route pattern, without patient identifiers.
 * Keep it attached to the observation when refresh finishes asynchronously. */
export function authRequestSurface(request: any): string | null {
  const path = request?.route?.path;
  return typeof path === 'string' && typeof request?.method === 'string'
    ? request.method.toUpperCase() + ' ' + path.replace(/^\/?api\//, '').replace(/^\//, '') : null;
}

export function sessionEndEvent(affected: SessionRecordIdentity, observation: {
  surface: string; roles: readonly string[]; rightsVersion: number; institution: string | null;
  auditRef: string; ip: string | null; occurredAt: string; endCause: AuthEndCause;
  trigger: ReauthenticationTrigger | null;
  service?: Extract<EvidenceFactV2<ImmutableIdentity>, { status: 'known' }>;
}): AuthAccessEventV2 {
  const event = sessionAccessEvent(affected, { ...observation, action: 'auth.entry' });
  return { ...event, surface: observation.surface,
    action: ['idle', 'refresh-failed', 'sweep'].includes(observation.endCause) ? 'auth.session.expired' : 'auth.logout',
    auth: { endCause: observation.endCause, failureCause: null, trigger: observation.trigger },
    ...(observation.service ? { userId: observation.service, executor: 'service' as const,
      rolesAtTime: { status: 'known' as const, value: [] },
      rightsVersion: { status: 'not-applicable' as const, reason: 'in-process-service' as const },
      actingInstitution: { status: 'not-applicable' as const, reason: 'in-process-service' as const },
      trustedProxyIp: { status: 'not-applicable' as const, reason: 'in-process-service' as const },
      cause: 'service-job' as const,
      context: { basis: 'service-job' as const, studyId: null, relatedStudyId: null, reason: null },
    } : {}),
  };
}

/** Facts already decided by the auth producer under its ordinary member lock.
 * The member's current institution scopes this session, while a waiting member
 * has no institution yet. No credential is used as an audit correlation. */
export function sessionAccessEvent(user: SessionRecordIdentity, observation: {
  action: 'auth.login' | 'auth.entry';
  roles: readonly string[]; rightsVersion: number; institution: string | null;
  auditRef: string; ip: string | null; occurredAt: string;
}): AuthAccessEventV2 {
  return {
    formatVersion: 2, branch: 'online-auth',
    surface: observation.action === 'auth.login' ? 'GET auth/callback' : 'POST auth/entry', eventId: randomUUID(),
    userId: user, affectedIdentity: user,
    rolesAtTime: { status: 'known', value: observation.roles }, rightsVersion: { status: 'known', value: observation.rightsVersion },
    actingInstitution: observation.institution ? { status: 'known', value: observation.institution }
      : { status: 'not-applicable', reason: 'not-approved' },
    managingInstitution: observation.institution ? { status: 'known', value: observation.institution }
      : { status: 'unresolved', reason: 'not-resolved' },
    occurredAt: observation.occurredAt,
    trustedProxyIp: observation.ip ? { status: 'known', value: { address: observation.ip, source: 'trusted-proxy' } }
      : { status: 'unresolved', reason: 'not-observed' },
    cause: 'user-view', context: { basis: 'authentication', studyId: null, relatedStudyId: null, reason: null },
    executor: 'member', session: { status: 'known', value: observation.auditRef }, targets: [],
    action: observation.action, result: 'succeeded', auth: { endCause: null, failureCause: null, trigger: null },
    requestId: randomUUID(), auditLinkId: 'audit:' + randomUUID(), relatedEventId: null,
  };
}

/** Login failures precede product-session creation. Preserve unknown facts rather
 * than assigning the attempted account, a session or a hospital by inference. */
export async function recordLoginFailure(port: EmrRecordPort, observation: {
  cause: AuthFailureCause; occurredAt: string; ip: string | null;
  verified: { issuer: string; subject: string; actor: string; institution: string | null } | null;
  legacyCause: string;
}): Promise<void> {
  const work = port.begin();
  try {
    const verified = observation.verified;
    const user: EvidenceFactV2<ImmutableIdentity> = verified
      ? await knownIdentity(verifiedIdentityClaims(verified.issuer, verified.subject, verified.actor),
        (issuer, subject) => work.resolveRequestIdentity(issuer, subject))
      : { status: 'unresolved', reason: 'not-authenticated' };
    const event: AuthAccessEventV2 = {
      formatVersion: 2, branch: 'online-auth', surface: 'GET auth/callback', eventId: randomUUID(),
      userId: user, affectedIdentity: user,
      rolesAtTime: { status: 'unresolved', reason: verified ? 'not-resolved' : 'not-authenticated' },
      rightsVersion: { status: 'unresolved', reason: verified ? 'not-resolved' : 'not-authenticated' },
      actingInstitution: verified?.institution ? { status: 'known', value: verified.institution }
        : { status: 'unresolved', reason: verified ? 'not-observed' : 'not-authenticated' },
      managingInstitution: { status: 'unresolved', reason: 'not-resolved' },
      occurredAt: observation.occurredAt,
      trustedProxyIp: observation.ip ? { status: 'known', value: { address: observation.ip, source: 'trusted-proxy' } }
        : { status: 'unresolved', reason: 'not-observed' },
      cause: 'user-view', context: { basis: 'authentication', studyId: null, relatedStudyId: null, reason: null },
      executor: verified ? 'member' : 'unauthenticated', session: { status: 'unresolved', reason: 'not-resolved' },
      targets: [], action: 'auth.login',
      result: (AUTH_FAILURE_CAUSES.failed as readonly string[]).includes(observation.cause) ? 'failed' : 'refused',
      auth: { endCause: null, failureCause: observation.cause, trigger: null },
      requestId: randomUUID(), auditLinkId: 'audit:' + randomUUID(), relatedEventId: null,
    };
    const operation = await work.admit(event);
    const outcome = await work.transaction(operation, async tx => {
      const row = await tx.auditLog.create({ data: {
        at: new Date(observation.occurredAt), actor: verified?.actor ?? 'unknown', action: event.action,
        target: verified?.subject ?? '', detail: JSON.stringify({ institution: verified?.institution ?? null,
          ip: observation.ip, dataSubject: null, outcome: 'failure', cause: observation.legacyCause }),
      } });
      return { kind: 'AuditLog', id: String(row.id), version: null };
    });
    if (outcome.outcome !== 'committed') throw new Error('AuthFailureRecordNotCommitted');
  } finally { work.end(); }
}
