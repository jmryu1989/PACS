import { Prisma } from '@prisma/client';
import { SQL_STORAGE_CLASSIFICATION } from '../emr-contract/classification';
import { freeze } from '../emr-contract/validation';

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

/** Operator diagnostics contain deployment declarations and closed failure classes, never provider/SQL error text. */
export function startupFailureMessage(error: unknown): string {
  if (error instanceof EmrRuntimeRefused)
    return `접속 원장 역할/저장소 검증 실패(kin_runtime): ${error.problems.join(', ')}. 기동을 중단합니다.`;
  const messages: Record<string, string> = {
    EmrManagingInstitutionRequired: 'KIN_EMR_MANAGING_INSTITUTION 설정이 없습니다',
    EmrProxyHostRequired: 'KIN_EMR_PROXY_HOST 설정이 없습니다',
    EmrStateDirectoryRequired: 'KIN_EMR_STATE_DIR 경로가 없거나 보호 디렉터리가 아닙니다',
    EmrStateDirectoryExposed: 'KIN_EMR_STATE_DIR 디렉터리 권한이 노출되어 있습니다',
    AuthLedgerNotPrepared: '접속 원장 초기화가 완료되지 않았습니다',
    SealUnavailable: '접속 원장 seal tail에 접근할 수 없습니다',
    SealCorrupt: '접속 원장 seal tail 검증에 실패했습니다',
    SealMissing: '접속 원장 seal tail이 없습니다',
    SealChainMismatch: '접속 원장 seal tail의 체인 식별자가 다릅니다',
    LedgerBehindSeal: '접속 원장이 보존된 seal tail보다 뒤에 있습니다',
    SealTailMismatch: '접속 원장과 보존된 seal tail이 일치하지 않습니다',
    LedgerChainBroken: '접속 원장의 체인 연결 검증에 실패했습니다',
    UnsealedEntryUnexplained: '접속 원장 seal tail 이후의 기록을 복구할 수 없습니다',
    SealUpgradeRequired: '접속 원장 seal tail 형식의 검토된 갱신이 필요합니다',
    FailureJournalUnavailable: '접속 원장 복구 저널에 접근할 수 없습니다',
    FailureJournalFull: '접속 원장 복구 저널 용량이 가득 찼습니다',
    FailureJournalCorrupt: '접속 원장 복구 저널 검증에 실패했습니다',
  };
  const value = error as { code?: string; message?: string; name?: string };
  const message = messages[value?.code ?? ''] ?? messages[value?.message ?? ''];
  const name = /^(?:[A-Za-z][A-Za-z0-9]{0,63})?(?:Error|Exception)$/.test(value?.name ?? '') ? value.name : 'Error';
  return `${message ?? `서비스 초기화 실패(${name})`}. 기동을 중단합니다.`;
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
