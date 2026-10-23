import { createHash, randomUUID } from 'crypto';
import { APP_ROLES } from './clinician-policy';
import type { AccessEventV1, ImmutableIdentity } from './emr-contract/access-event';

/** The controller's server-observed request context, never request-body fields. */
export interface RightsRequestFacts {
  surface: string; actor: ImmutableIdentity; roles: readonly string[]; rightsVersion: number;
  institution: string | null; ip: string | null; sessionRef: string | null; requestId: string;
  ipSource?: 'trusted-proxy' | 'request-peer';
}

export function rightsAccessEvent(facts: RightsRequestFacts, affected: ImmutableIdentity,
  version: number, occurredAt: string): AccessEventV1 {
  const nonRecord = { status: 'not-applicable' as const, reason: 'non-record-target' as const };
  return { formatVersion: 1, surface: facts.surface, eventId: randomUUID(),
    userId: { status: 'known', value: facts.actor }, rolesAtTime: { status: 'known', value: facts.roles },
    actingInstitution: facts.institution ? { status: 'known', value: facts.institution }
      : { status: 'unresolved', reason: 'not-observed' },
    managingInstitution: facts.institution ? { status: 'known', value: facts.institution }
      : { status: 'unresolved', reason: 'not-resolved' },
    trustedProxyIp: facts.ip ? { status: 'known', value: { address: facts.ip, source: facts.ipSource ?? 'trusted-proxy' } }
      : { status: 'unresolved', reason: 'not-observed' },
    occurredAt, cause: 'user-view', executor: 'member',
    context: { basis: 'out-of-context', studyId: null, relatedStudyId: null, reason: null },
    targets: [{ kind: 'identity-access', patientLinkSnapshot: nonRecord, studyId: nonRecord,
      recordId: { status: 'known', value: affected.id }, versionId: { status: 'known', value: String(version) } }],
    action: 'modify', result: 'succeeded', requestId: facts.requestId,
    auditLinkId: 'audit:' + randomUUID(), relatedEventId: null };
}

// The same member lock serializes commands, session admission, and proof/refresh writes.
export async function lockMemberRights(tx: any, sub: string): Promise<void> {
  const key = createHash('sha256').update(`${process.env.KC_ISSUER}\n${sub}`).digest().readInt32BE(0);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${0x4b494e4d}::int4, ${key}::int4)`;
}

export function rightsAllow(row: any): boolean {
  return !!row && row.approved && !row.suspended && !!row.institution
    && row.roles.length > 0 && row.roles.every((role: string) => APP_ROLES.has(role));
}

// The roster keeps provider names; eligibility comes only from this durable authority.
export function rightsUser(row: any) {
  return row && { id: row.sub, username: row.username, email: row.email, emailVerified: row.emailVerified,
    firstName: row.name, lastName: '', enabled: rightsAllow(row), serviceAccountClientId: null,
    groups: row.institution ? [row.institution] : [], roles: row.approved ? row.roles : [] };
}

/** An older ordinary publication may have landed after the latest intent was created. */
export function rosterOverlap(records: { state: string; createdAt: Date; settledAt: Date | null }[]): boolean {
  const latest = records[0];
  return !!latest && records.slice(1).some(row => row.state === 'done' && row.settledAt
    && row.settledAt.getTime() > latest.createdAt.getTime());
}
