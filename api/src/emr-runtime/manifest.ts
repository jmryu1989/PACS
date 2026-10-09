import { Prisma } from '@prisma/client';
import { SQL_STORAGE_CLASSIFICATION } from '../emr-contract/classification';
import { freeze } from '../emr-contract/validation';

/**
 * EMR-B deployment manifest: what the runtime verifies of the database before it may write a ledger fact. The unit
 * declaration emr/units/b.json lists the same sets and the contract/live tests hold both against the actual catalog.
 * Role names are fixed; secrets never appear here (provisioning supplies them from outside the repository).
 */
export const EMR_MIGRATION = '20261008120000_emr_b';
export const EMR_STORAGE = freeze({
  schema: 'emr_access',
  tablespace: 'kin_emr_access',
  roles: { owner: 'kin_emr_owner', runtime: 'kin_runtime', reader: 'kin_emr_reader', retention: 'kin_emr_retention' },
  tables: ['access_entry', 'audit_projection', 'chain_head', 'clause_version', 'duty_request_event', 'legal_hold_event', 'member_identity'],
  runtimeFunctions: [
    'append_access(text,text,timestamptz)', 'chain_tail()', 'entries_after(bigint,integer)', 'entry_for_event(text)',
    'storage_placement()', 'civil_period_end(timestamptz,integer)', 'resolve_member_identity(text,text)',
    'record_projection(text,integer)', 'place_hold(text,text,text)', 'release_hold(text,text)', 'holds_for(text)',
    'record_duty_request(text,text,text,text)', 'duty_requests(text,text)', 'clause_versions(text)',
  ],
  readerFunctions: [
    'chain_tail()', 'entries_after(bigint,integer)', 'entry_for_event(text)', 'storage_placement()', 'civil_period_end(timestamptz,integer)',
    'holds_for(text)', 'duty_requests(text,text)', 'clause_versions(text)',
  ],
  retentionFunctions: ['expire_prefix(bigint)', 'retention_view(bigint,integer)', 'chain_tail()', 'storage_placement()'],
  /** Never callable by the runtime: deletion and the clause history installer. */
  forbiddenToRuntime: ['expire_prefix(bigint)', 'record_clause_version(text,text,text,text,date,date)'],
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
      pg_catalog.has_table_privilege('emr_access.access_entry', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS direct_write,
      pg_catalog.has_function_privilege('emr_access.append_access(text,text,timestamptz)', 'EXECUTE') AS append,
      pg_catalog.has_function_privilege('emr_access.expire_prefix(bigint)', 'EXECUTE') AS expire,
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
