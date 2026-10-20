import { Prisma } from '@prisma/client';
import { SQL_STORAGE_CLASSIFICATION } from '../emr-contract/classification';
import { freeze } from '../emr-contract/validation';
import type { DatabaseIdentity } from './state-protocol';

/**
 * EMR-B deployment manifest: what the runtime verifies of the database before it may write a ledger fact. The unit
 * declaration emr/units/b.json lists the same sets and the contract/live tests hold both against the actual catalog.
 * Role names are fixed; secrets never appear here (provisioning supplies them from outside the repository).
 */
export const EMR_MIGRATION = '20261010120000_emr_seal_attempts';
export const EMR_STORAGE = freeze({
  schema: 'emr_access',
  tablespace: 'kin_emr_access',
  roles: { owner: 'kin_emr_owner', runtime: 'kin_runtime', reader: 'kin_emr_reader', retention: 'kin_emr_retention' },
  tables: ['access_entry', 'access_target', 'audit_projection', 'chain_head', 'clause_version', 'commit_marker', 'duty_request_event', 'legal_hold_event', 'member_identity', 'order_fact'],
  runtimeFunctions: [
    'enter_writer()', 'fence_writers()', 'commit_marker_for_slot(text,bigint)', 'commit_marker_for_attempt(text,text)', 'bind_commit(text,text,bigint,text)',
    'append_reserved(text,text,text,text,text,text)', 'chain_tail(text)', 'entries_after(text,bigint,integer)', 'entry_for_event(text,text)',
    'storage_placement()', 'civil_period_end(timestamptz,integer)', 'resolve_member_identity(text,text)',
    'record_projection(text,integer)', 'place_hold(text,text,text)', 'release_hold(text,text)', 'holds_for(text)',
    'record_duty_request(text,text,text,text)', 'duty_requests(text,text)', 'clause_versions(text)',
    'order_facts_for(text)', 'record_order_fact(text,text,text,text)',
  ],
  readerFunctions: [
    'enter_writer()', 'fence_writers()', 'commit_marker_for_slot(text,bigint)', 'commit_marker_for_attempt(text,text)',
    'chain_tail(text)', 'entries_after(text,bigint,integer)', 'entry_for_event(text,text)', 'storage_placement()', 'civil_period_end(timestamptz,integer)',
    'holds_for(text)', 'duty_requests(text,text)', 'clause_versions(text)', 'order_facts_for(text)',
  ],
  retentionFunctions: ['enter_writer()', 'fence_writers()', 'commit_marker_for_slot(text,bigint)', 'commit_marker_for_attempt(text,text)', 'bind_commit(text,text,bigint,text)', 'lock_chain(text)', 'expire_reserved(bigint,text,text)', 'retention_view(bigint,integer)', 'chain_tail(text)', 'storage_placement()'],
  /** Never callable by the runtime: deletion and the clause history installer. */
  forbiddenToRuntime: ['expire_reserved(bigint,text,text)', 'record_clause_version(text,text,text,text,date,date)'],
  stateDirectoryVariable: 'KIN_EMR_STATE_DIR',
});
{
  const declared = Object.keys(SQL_STORAGE_CLASSIFICATION).map(name => name.replace(/^emr_access\./, '')).sort();
  if (JSON.stringify(declared) !== JSON.stringify([...EMR_STORAGE.tables].sort())) throw new Error('EMR storage manifest and classification differ');
}

/** Prisma's parameterized raw query surface, from a client or an interactive transaction. */
export interface RawQuery { $queryRaw<T = unknown>(query: TemplateStringsArray | Prisma.Sql, ...values: any[]): Promise<T> }

export class EmrRuntimeRefused extends Error {
  constructor(readonly problems: readonly string[]) { super(`EmrRuntimeRefused: ${problems.join(', ')}`); this.name = 'EmrRuntimeRefused'; }
}

/**
 * The runtime connection is the least-privilege application role and the ledger is placed: refuse otherwise. Reads only
 * catalog facts the role can see; reports closed problem codes, never connection strings or secrets.
 */
export async function verifyRuntimeConnection(db: RawQuery): Promise<{ role: string; relations: number }> {
  const problems: string[] = [];
  const [role] = await db.$queryRaw<any[]>`SELECT current_user::text AS name, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication,
    r.rolbypassrls, (SELECT count(*)::int FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid) AS memberships,
    (SELECT count(*)::int FROM pg_catalog.pg_class c WHERE c.relowner = r.oid) AS owned,
    (SELECT count(*)::int FROM pg_catalog.pg_namespace n WHERE n.nspowner = r.oid) AS owned_schemas
    FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`;
  if (!role) throw new EmrRuntimeRefused(['role-unreadable']);
  if (role.name !== EMR_STORAGE.roles.runtime) problems.push('not-the-runtime-role');
  for (const attribute of ['rolsuper', 'rolcreaterole', 'rolcreatedb', 'rolreplication', 'rolbypassrls']) if (role[attribute] !== false) problems.push(attribute);
  if (role.memberships !== 0) problems.push('role-membership');
  if (role.owned !== 0 || role.owned_schemas !== 0) problems.push('owns-objects');
  const [owners] = await db.$queryRaw<any[]>`SELECT count(*)::int AS reachable FROM (
      SELECT DISTINCT c.relowner FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public', 'emr_access')) o
    WHERE pg_catalog.pg_has_role(current_user, o.relowner, 'USAGE')`;
  if (owners.reachable !== 0) problems.push('owner-reachable');
  const [table] = await db.$queryRaw<any[]>`SELECT pg_catalog.to_regclass('emr_access.access_entry') IS NOT NULL AS present`;
  if (!table.present) throw new EmrRuntimeRefused([...problems, 'ledger-missing']);
  const [privileges] = await db.$queryRaw<any[]>`SELECT
      (pg_catalog.has_table_privilege('emr_access.commit_marker', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR pg_catalog.has_table_privilege('emr_access.access_entry', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR pg_catalog.has_table_privilege('emr_access.access_target', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) AS direct_write,
      pg_catalog.has_function_privilege('emr_access.append_reserved(text,text,text,text,text,text)', 'EXECUTE') AS append,
      pg_catalog.has_function_privilege('emr_access.expire_reserved(bigint,text,text)', 'EXECUTE') AS expire,
      pg_catalog.has_function_privilege('emr_access.record_clause_version(text,text,text,text,date,date)', 'EXECUTE') AS clauses,
      pg_catalog.has_schema_privilege('emr_access', 'CREATE') AS create_ledger,
      pg_catalog.has_schema_privilege('public', 'CREATE') AS create_public`;
  if (privileges.direct_write !== false) problems.push('direct-ledger-write');
  if (privileges.append !== true) problems.push('append-not-granted');
  if (privileges.expire !== false || privileges.clauses !== false) problems.push('retention-or-installer-reachable');
  if (privileges.create_ledger !== false || privileges.create_public !== false) problems.push('ddl-reachable');
  const placement = await db.$queryRaw<{ relation: string; relkind: string; tablespace: string }[]>`SELECT relation, relkind, tablespace FROM emr_access.storage_placement()`;
  const tables = placement.filter(p => p.relkind === 'r').map(p => p.relation).sort();
  if (JSON.stringify(tables) !== JSON.stringify([...EMR_STORAGE.tables].sort())) problems.push('ledger-relations-differ');
  if (placement.some(p => p.tablespace !== EMR_STORAGE.tablespace)) problems.push('ledger-placement');
  if (problems.length) throw new EmrRuntimeRefused(problems);
  return { role: role.name, relations: placement.length };
}

/** Fixed deployment identities; Compose/image/preflight consumers must use the same values.
 * The existing protected volume keeps the node UID. Client groups can connect but cannot replace sockets. */
export const EMR_STATE_IDENTITIES = freeze({ serviceUid: 1000, apiUid: 1001, apiGroup: 2001, retentionGroup: 2002 });

export async function databaseIdentity(db: RawQuery): Promise<DatabaseIdentity> {
  const [row] = await db.$queryRaw<any[]>`SELECT current_database()::text AS database, d.oid::int AS oid,
    inet_server_addr()::text AS address, inet_server_port() AS port
    FROM pg_catalog.pg_database d WHERE d.datname = current_database()`;
  if (!row || typeof row.database !== 'string' || !Number.isSafeInteger(row.oid) || row.oid < 1 ||
    !(row.address === null || typeof row.address === 'string') ||
    !(row.port === null || Number.isInteger(row.port) && row.port > 0 && row.port <= 65535))
    throw new EmrRuntimeRefused(['database-identity-unreadable']);
  return { database: row.database, oid: row.oid, address: row.address, port: row.port };
}

/** Independently verify the service's reader credential. It must not inherit application,
 * deletion or installer authority, even if the required read functions happen to succeed. */
export async function verifyStateServiceConnection(db: RawQuery): Promise<{ role: string; relations: number }> {
  const problems: string[] = [];
  const [role] = await db.$queryRaw<any[]>`SELECT current_user::text AS name, r.rolsuper, r.rolcreaterole,
    r.rolcreatedb, r.rolreplication, r.rolbypassrls, r.rolcanlogin,
    (SELECT count(*)::int FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid) AS memberships,
    (SELECT count(*)::int FROM pg_catalog.pg_class c WHERE c.relowner = r.oid) AS owned,
    (SELECT count(*)::int FROM pg_catalog.pg_namespace n WHERE n.nspowner = r.oid) AS owned_schemas
    FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`;
  if (!role) throw new EmrRuntimeRefused(['role-unreadable']);
  if (role.name !== EMR_STORAGE.roles.reader) problems.push('not-the-state-reader-role');
  for (const key of ['rolsuper', 'rolcreaterole', 'rolcreatedb', 'rolreplication', 'rolbypassrls'])
    if (role[key] !== false) problems.push(key);
  if (role.rolcanlogin !== true) problems.push('reader-login-required');
  if (role.memberships !== 0) problems.push('role-membership');
  if (role.owned !== 0 || role.owned_schemas !== 0) problems.push('owns-objects');
  const [privileges] = await db.$queryRaw<any[]>`SELECT
    EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public', 'emr_access') AND c.relkind IN ('r','p','v','m','f') AND
      pg_catalog.has_table_privilege(c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) AS direct_write,
    EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname IN ('public', 'emr_access') AND
      pg_catalog.has_schema_privilege(n.oid, 'CREATE')) AS create_schema,
    pg_catalog.has_database_privilege(current_database(), 'CREATE') AS create_database,
    EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname IN ('kin_emr_owner','kin_runtime','kin_emr_retention') AND
      pg_catalog.pg_has_role(current_user, r.oid, 'USAGE')) AS owner_reachable`;
  for (const key of ['direct_write', 'create_schema', 'create_database', 'owner_reachable'])
    if (privileges?.[key] !== false) problems.push(key);
  const functions = await db.$queryRaw<{ signature: string; executable: boolean }[]>`SELECT
    p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')' AS signature,
    pg_catalog.has_function_privilege(p.oid, 'EXECUTE') AS executable
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'emr_access'`;
  const allowed = new Set<string>(EMR_STORAGE.readerFunctions);
  const granted = new Set(functions.filter(f => f.executable).map(f => f.signature.replace(/, /g, ',').replace(/timestamp with time zone/g, 'timestamptz')));
  if (granted.size !== allowed.size || [...allowed].some(f => !granted.has(f))) problems.push('reader-functions-differ');
  const placement = await db.$queryRaw<{ relation: string; relkind: string; tablespace: string }[]>`SELECT relation, relkind, tablespace FROM emr_access.storage_placement()`;
  if (JSON.stringify(placement.filter(p => p.relkind === 'r').map(p => p.relation).sort()) !==
    JSON.stringify([...EMR_STORAGE.tables].sort())) problems.push('ledger-relations-differ');
  if (placement.some(p => p.tablespace !== EMR_STORAGE.tablespace)) problems.push('ledger-placement');
  if (problems.length) throw new EmrRuntimeRefused(problems);
  return { role: role.name, relations: placement.length };
}
