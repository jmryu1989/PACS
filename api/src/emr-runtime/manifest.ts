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

const STARTUP_PHASES: Readonly<Record<string, string>> = freeze({
  create: 'Nest 애플리케이션 구성에 실패했습니다',
  config: '접속 원장 설정을 확인하지 못했습니다',
  connect: '접속 원장 DB에 연결하지 못했습니다',
  role: '접속 원장 DB 역할·저장소를 확인하지 못했습니다',
  fence: '접속 원장 상태 디렉터리의 소유를 확인하지 못했습니다',
  recovery: '접속 원장 seal·복구 저널을 복구하지 못했습니다',
  compose: '접속 원장 reader를 구성하지 못했습니다',
  clinical: '임상 기동 준비·구성·준비 확인에 실패했습니다',
  init: '서비스 초기화에 실패했습니다',
  listen: 'HTTP 수신을 시작하지 못했습니다',
});
const STARTUP_CODES: Readonly<Record<string, string>> = freeze({
  EmrDatabaseUrlRequired: 'DATABASE_URL이 없거나 PostgreSQL 주소가 아닙니다',
  EmrAppendPoolTooSmall: 'DATABASE_URL의 connection_limit가 접속 원장 검증 예비 연결보다 작습니다',
  EmrStateDirectoryRequired: 'KIN_EMR_STATE_DIR 경로가 없거나 보호 디렉터리가 아닙니다',
  EmrStateDirectoryExposed: 'KIN_EMR_STATE_DIR 디렉터리 권한이 다른 사용자에게 열려 있습니다',
  EmrProxyHostRequired: 'KIN_EMR_PROXY_HOST 설정이 없습니다',
  EmrProxyHostInvalid: 'KIN_EMR_PROXY_HOST가 프록시의 호스트 이름이나 IP 하나가 아닙니다(loopback 불가)',
  EmrStartupPlanInvalid: '기동 계획(base/clinical)을 해석할 수 없습니다',
  EmrStartupRepeated: '접속 원장 기동이 이미 시작되었습니다',
  EmrStartupInterrupted: '접속 원장 기동 중에 종료가 시작되었습니다',
  P1000: 'DB 인증에 실패했습니다', P1001: 'DB 서버에 닿지 못했습니다', P1002: 'DB 서버 응답 시간이 초과되었습니다',
  P1003: 'DB가 없습니다', P1008: 'DB 작업 시간이 초과되었습니다', P1010: 'DB 접근이 거부되었습니다',
  P1011: 'DB TLS 연결을 열지 못했습니다', P1017: 'DB 서버가 연결을 닫았습니다', P2024: 'DB 연결 풀 대기 시간이 초과되었습니다',
  EmrRuntimeRefused: '접속 원장 DB 역할·저장소 검증에 실패했습니다(최소권한 kin_runtime과 전용 저장소가 필요합니다)',
  EmrStateOwnerBusy: '다른 API 프로세스가 같은 KIN_EMR_STATE_DIR의 원장 상태를 소유하고 있습니다',
  SealUnavailable: '접속 원장 보호 상태에 접근할 수 없습니다',
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
  FailureJournalConflict: '접속 원장 복구 저널의 기록이 서로 다릅니다',
  EmrAdaptersAlreadyComposed: '접속 원장 reader가 이미 구성되었습니다',
  EmrAdapterRequired: '접속 원장 reader 구성에 필요한 부분이 없습니다',
  EmrClinicalFactoryRequired: '임상 기동 계획에 준비 함수가 없습니다',
  EmrClinicalPreparedInvalid: '임상 준비 결과에 reader·구성·정리가 없습니다',
  EmrClinicalLifecycleInvalid: '임상 수명 객체에 준비 확인·시작·중지가 없습니다',
  EADDRINUSE: 'HTTP 포트가 이미 사용 중입니다', EACCES: 'HTTP 포트를 열 권한이 없습니다',
});
/**
 * EMR-B2-BASE: the one line a failed API start prints (main.ts), with a closed phase and, when the thrown value is one of
 * the explicitly mapped classes, its closed code: EmrRuntimeRefused by its class only (never its problems), the start-up,
 * seal and journal refusals by their code, the listed provider connection codes and the two listen errors. Anything else
 * is the phase's own line. No message, name, URL, SQL, bind value, stack or newline of the thrown value reaches it -
 * provider errors can carry credential-bearing connection strings.
 */
export function startupFailureMessage(phase: 'create' | 'config' | 'connect' | 'role' | 'fence' | 'recovery' | 'compose' | 'clinical' | 'init' | 'listen',
  error: unknown): string {
  const step = Object.prototype.hasOwnProperty.call(STARTUP_PHASES, phase) ? phase : 'create';
  const value = (error !== null && typeof error === 'object' ? error : {}) as { code?: unknown; errorCode?: unknown; message?: unknown };
  const candidates = error instanceof EmrRuntimeRefused ? ['EmrRuntimeRefused'] : [value.errorCode, value.code, value.message];
  const code = candidates.find(item => typeof item === 'string' && Object.prototype.hasOwnProperty.call(STARTUP_CODES, item)) as string | undefined;
  return `기동 실패(${step}${code ? '/' + code : ''}): ${code ? STARTUP_CODES[code] : STARTUP_PHASES[step]}. 기동을 중단합니다.`;
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
