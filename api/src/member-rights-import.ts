import { decodeJwt } from 'jose';
import { APP_ROLES } from './clinician-policy';
import { KeycloakService, KeycloakUser } from './keycloak.service';
import { PrismaService } from './prisma.service';

/** Run once with member administration stopped, before enabling traffic for the new schema.
 * Reads every realm member, including those without an AuthSession. Never import again over DB rights.
 * Missing/disabled/uncertain legacy accounts remain refused; old provider records are retained untouched.
 */
export async function importMemberRights(prisma: PrismaService, keycloak: KeycloakService, signal?: AbortSignal) {
  if (await prisma.memberRightsImport.findUnique({ where: { id: 'realm-v1' } })) return;
  const users: KeycloakUser[] = [];
  let expectedTotal: number | null = null;
  for (let page = 1; ; page++) {
    const result = await keycloak.listUsers(page, signal);
    if (!Number.isInteger(result.total) || result.total < 0 || (expectedTotal !== null && result.total !== expectedTotal))
      throw new Error('Unstable realm member import');
    expectedTotal = result.total;
    users.push(...result.users);
    if (users.length >= result.total) break;
    if (!result.users.length) throw new Error('Incomplete realm member import');
  }
  if (users.length !== expectedTotal || new Set(users.map(user => user.id)).size !== users.length) throw new Error('Unstable realm member import');
  await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${0x4b494e4d}::int4, ${0}::int4)`;
    if (await tx.memberRightsImport.findUnique({ where: { id: 'realm-v1' } })) return;
    for (const user of users) {
      const isolated = await tx.memberIsolation.findUnique({ where: { sub: user.id } });
      const unknown = await tx.providerChange.findFirst({ where: { sub: user.id, kind: { in: ['disable', 'enable'] }, state: 'unknown' } });
      const roles = user.roles.filter(role => APP_ROLES.has(role));
      const approved = user.groups.length === 1 && roles.length > 0 && !user.roles.includes('gateway');
      const row = await tx.memberRights.upsert({ where: { sub: user.id }, update: {}, create: {
        sub: user.id, username: user.username, email: user.email,
        name: [user.lastName, user.firstName].filter(Boolean).join(' ') || user.username,
        emailVerified: user.emailVerified, approved, suspended: !user.enabled || !!isolated || !!unknown,
        institution: approved ? user.groups[0] : null, roles: approved ? roles : [],
      } });
      const sessions = await tx.authSession.findMany({ where: { sub: user.id } });
      for (const session of sessions) {
        let same = false;
        try {
          const token: any = decodeJwt(session.accessToken);
          const groups = (token.groups ?? []).map((group: string) => group.replace(/^\//, ''));
          const oldRoles = (token.realm_access?.roles ?? []).filter((role: string) => APP_ROLES.has(role)).sort();
          same = token.sub === session.sub && groups.length === 1 && groups[0] === row.institution && JSON.stringify(oldRoles) === JSON.stringify([...row.roles].sort());
        } catch { /* Unreadable legacy credentials cannot be admitted. */ }
        // An incompatible old session remains a refusal (version 0), without inventing a remote logout.
        await tx.authSession.update({ where: { sid: session.sid }, data: {
          rightsVersion: same && row.approved && !row.suspended ? row.version : 0, institution: row.institution,
        } });
      }
    }
    await tx.memberRightsImport.create({ data: { id: 'realm-v1' } });
  }, { maxWait: 4000, timeout: 120000 });
}
