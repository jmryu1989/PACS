import { createHash } from 'crypto';
import { APP_ROLES } from './clinician-policy';

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
