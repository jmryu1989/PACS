import { decodeJwt } from 'jose';
import { APP_ROLES } from './clinician-policy';
import { Logger } from '@nestjs/common';
import { KeycloakService, KeycloakUser, RosterWriteFailure } from './keycloak.service';
import { PrismaService } from './prisma.service';
import { lockMemberRights } from './member-rights';

/** Run once with member administration stopped, before enabling traffic for the new schema.
 * Reads every realm member, including those without an AuthSession. Never import again over DB rights.
 * Missing/disabled/uncertain legacy accounts remain refused; old provider records are retained untouched.
 * Only this transition lifts the legacy provider disable; PACS suspension is an independent DB decision.
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
  const changes = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${0x4b494e4d}::int4, ${0}::int4)`;
    if (await tx.memberRightsImport.findUnique({ where: { id: 'realm-v1' } })) return [];
    const legacy = [];
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
      // Persist the send intent with the marker: a crash immediately after commit must remain recoverable.
      // The target distinguishes an import enable from an ordinary groups/roles publication without changing its kind.
      if (!user.enabled) legacy.push(await tx.providerChange.create({ data: {
        kind: 'credentials', target: 'legacy-enable:' + user.id, sub: user.id, generation: row.version,
        state: 'unknown', createdAt: new Date(),
      } }));
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
    // Import is one rights decision: stamp its commit boundary after all member/session work,
    // so a slow import cannot admit a Bearer authenticated between the first and last row.
    const completedAt = new Date();
    await tx.memberRights.updateMany({ where: { sub: { in: users.map(user => user.id) } }, data: {
      newAuthAfter: completedAt,
    } });
    await tx.memberRightsImport.create({ data: { id: 'realm-v1', completedAt } });
    return legacy;
  }, { maxWait: 4000, timeout: 120000 });
  const publications = changes.map(change => {
    // Neither startup, a member command, nor login waits for this one-shot post-commit send.
    return sendMemberRoster(prisma, keycloak, change).catch(() => new Logger('MemberRightsImport').warn('명부 반영 미확인'));
  });
  // The CLI drains its own I/O before disconnecting; API startup only awaits the import transaction above.
  return { publication: Promise.all(publications) };
}

/** Operator recovery uses the original recorded intent, never provider claims as PACS rights. */
async function sendMemberRoster(prisma: PrismaService, keycloak: KeycloakService, change: {
  id: number; sub: string | null; target: string; generation: number;
}) {
  let answer: { state: string; outcome: string };
  try {
    if (!change.sub) throw new Error('Missing member subject');
    if (change.target === 'legacy-enable:' + change.sub) {
      await keycloak.setEnabled(change.sub, true);
    } else {
      const rows = await prisma.auditLog.findMany({ where: { target: change.sub,
        action: { in: ['admin.user.approve', 'admin.user.update', 'admin.user.activate'] } }, orderBy: { id: 'desc' } });
      const snapshot = rows.map(row => JSON.parse(row.detail ?? '{}').after)
        .find(after => after?.version === change.generation);
      if (!snapshot?.institution || !Array.isArray(snapshot.roles)) throw new Error('Missing recorded roster');
      await keycloak.setGroups(change.sub, [snapshot.institution]);
      await keycloak.setRoles(change.sub, snapshot.roles);
    }
    answer = { state: 'done', outcome: 'completed' };
  } catch (error) {
    answer = error instanceof RosterWriteFailure ? error.answer : { state: 'unknown', outcome: 'credentials_unconfirmed' };
  }
  await prisma.providerChange.updateMany({ where: { id: change.id, state: 'unknown' }, data: {
    ...answer, settledAt: answer.state === 'unknown' ? null : new Date(),
  } });
  return answer.state;
}

/** Explicit CLI only: no lifecycle hook or login path calls this recovery. */
export async function retryMemberRoster(prisma: PrismaService, keycloak: KeycloakService) {
  const changes = await prisma.providerChange.findMany({ where: { kind: 'credentials', state: { in: ['unknown', 'void'] } }, orderBy: { id: 'asc' } });
  const outcomes: string[] = [];
  let superseded = 0;
  const members = new Set<string>();
  for (const change of changes) {
    if (change.target !== 'legacy-enable:' + change.sub && change.sub) {
      if (members.has(change.sub)) continue;
      members.add(change.sub);
      const claimed = await prisma.$transaction(async tx => {
        await lockMemberRights(tx, change.sub!);
        const records = await tx.providerChange.findMany({ where: { kind: 'credentials', sub: change.sub,
          target: change.sub! }, orderBy: { id: 'desc' } });
        const latest = records[0];
        if (!latest) return { send: null, superseded: 0 };
        // An older failed publication must never overwrite an already confirmed newer generation.
        const older = records.slice(1).filter(row => ['unknown', 'void'].includes(row.state) && row.outcome !== 'superseded');
        const settled = await tx.providerChange.updateMany({ where: { id: { in: older.map(row => row.id) },
          state: { in: ['unknown', 'void'] } }, data: { state: 'void', outcome: 'superseded', settledAt: new Date() } });
        const send = ['unknown', 'void'].includes(latest.state) ? latest : null;
        if (send) await tx.providerChange.update({ where: { id: send.id }, data: { state: 'unknown', outcome: null, settledAt: null } });
        return { send, superseded: settled.count };
      });
      superseded += claimed.superseded;
      if (claimed.send) outcomes.push(await sendMemberRoster(prisma, keycloak, claimed.send));
      continue;
    }
    const claimed = await prisma.providerChange.updateMany({ where: { id: change.id, state: { in: ['unknown', 'void'] } },
      data: { state: 'unknown', outcome: null, settledAt: null } });
    if (claimed.count) outcomes.push(await sendMemberRoster(prisma, keycloak, change));
  }
  return { attempted: outcomes.length, unconfirmed: outcomes.filter(state => state !== 'done').length, superseded };
}
