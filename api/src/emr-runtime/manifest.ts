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

const STARTUP_PHASES: Readonly<Record<string, string>> = freeze({
  create: 'Nest 애플리케이션 구성에 실패했습니다',
  config: '접속 원장 설정을 확인하지 못했습니다',
  connect: '접속 원장 DB에 연결하지 못했습니다',
  role: '접속 원장 DB 역할·저장소를 확인하지 못했습니다',
  session: '접속 원장 상태 서비스에 연결하지 못했습니다',
  pair: '접속 원장 상태 서비스와 이 API의 DB·체인·인스턴스가 다릅니다',
  compose: '접속 원장 reader를 구성하지 못했습니다',
  init: '서비스 초기화에 실패했습니다',
  listen: 'HTTP 수신을 시작하지 못했습니다',
});
const STARTUP_CODES: Readonly<Record<string, string>> = freeze({
  EmrDatabaseUrlRequired: 'DATABASE_URL이 없거나 PostgreSQL 주소가 아닙니다',
  EmrAppendPoolTooSmall: 'DATABASE_URL의 connection_limit가 접속 원장 검증 예비 연결보다 작습니다',
  EmrStateSocketRequired: 'KIN_EMR_STATE_SOCKET 경로가 없거나 절대 경로가 아닙니다',
  EmrStateInstanceRequired: 'KIN_EMR_INSTANCE_ID가 없습니다',
  EmrStateDirectoryForbidden: 'API 프로세스에 KIN_EMR_STATE_DIR가 주어졌습니다(보호 상태는 상태 서비스만 가집니다)',
  EmrStatePairMismatch: '상태 서비스가 보고한 인스턴스·DB·체인이 이 API가 관찰한 값과 다릅니다',
  EmrStartupRepeated: '접속 원장 기동이 이미 시작되었습니다',
  EmrStartupInterrupted: '접속 원장 기동 중에 종료 요청을 받아 기동을 멈췄습니다',
  P1000: 'DB 인증에 실패했습니다', P1001: 'DB 서버에 닿지 못했습니다', P1002: 'DB 서버 응답 시간이 초과되었습니다',
  P1003: 'DB가 없습니다', P1008: 'DB 작업 시간이 초과되었습니다', P1010: 'DB 접근이 거부되었습니다',
  P1011: 'DB TLS 연결을 열지 못했습니다', P1017: 'DB 서버가 연결을 닫았습니다', P2024: 'DB 연결 풀 대기 시간이 초과되었습니다',
  EmrRuntimeRefused: '접속 원장 DB 역할·저장소 검증에 실패했습니다(최소권한 kin_runtime과 전용 저장소가 필요합니다)',
  NOT_READY: '상태 서비스가 아직 복구를 마치지 않았습니다', STOPPING: '상태 서비스가 종료 중입니다',
  UNAVAILABLE: '상태 서비스에 연결할 수 없습니다', PROTOCOL: '상태 서비스의 응답이 프로토콜과 다릅니다',
  FORBIDDEN: '상태 서비스가 이 역할의 접속을 거절했습니다', SESSION: '상태 서비스 세션을 열지 못했습니다',
  OVERLOADED: '상태 서비스의 세션 한도에 도달했습니다', TIMEOUT: '상태 서비스 응답 시간이 초과되었습니다',
  EPOCH: '상태 서비스의 epoch가 바뀌었습니다', CLOSED: '상태 서비스 연결이 닫혔습니다',
  EmrAdaptersAlreadyComposed: '접속 원장 reader가 이미 구성되었습니다',
  EmrAdapterRequired: '접속 원장 reader 구성에 필요한 부분이 없습니다',
  EADDRINUSE: 'HTTP 포트가 이미 사용 중입니다', EACCES: 'HTTP 포트를 열 권한이 없습니다',
});
/**
 * EMR-B2 (c): the one line a failed API start prints (launcher.ts), with a closed phase and, when the thrown value is one
 * of the explicitly mapped classes, its closed code: EmrRuntimeRefused by its class only (never its problems), the
 * start-up refusals and state-protocol codes by their code, the listed provider connection codes and the two listen
 * errors. Anything else is the phase's own line. No message, name, URL, SQL, bind value, stack or newline of the thrown
 * value reaches it - provider errors can carry credential-bearing connection strings.
 */
export function startupFailureMessage(phase: 'create' | 'config' | 'connect' | 'role' | 'session' | 'pair' | 'compose' | 'init' | 'listen',
  error: unknown): string {
  const step = Object.prototype.hasOwnProperty.call(STARTUP_PHASES, phase) ? phase : 'create';
  const value = (error !== null && typeof error === 'object' ? error : {}) as { code?: unknown; errorCode?: unknown; message?: unknown };
  const candidates = error instanceof EmrRuntimeRefused ? ['EmrRuntimeRefused'] : [value.errorCode, value.code, value.message];
  const code = candidates.find(item => typeof item === 'string' && Object.prototype.hasOwnProperty.call(STARTUP_CODES, item)) as string | undefined;
  return `기동 실패(${step}${code ? '/' + code : ''}): ${code ? STARTUP_CODES[code] : STARTUP_PHASES[step]}. 기동을 중단합니다.`;
}

/** The closed phases of a stop that did not end within its bound (launcher.ts): the step the start was still in, the
 * drain of admitted requests, recording work and background tasks (10 s), the service's own close hooks and the
 * ledger client/session release (5 s). */
export type EmrStopPhase = 'start' | 'drain' | 'app' | 'ledger';
const STOP_PHASES: Readonly<Record<EmrStopPhase, string>> = freeze({
  start: '기동 중이던 단계가 5초 안에 끝나지 않았습니다',
  drain: '진행 중인 요청·접속 원장 기록 작업·배경 작업이 10초 안에 끝나지 않았습니다',
  app: '서비스 종료 훅이 5초 안에 끝나지 않았습니다',
  ledger: '접속 원장 연결·상태 서비스 세션 정리가 5초 안에 끝나지 않았습니다',
});
/** EMR-B2 (c): the one line a stop prints when a bound was exceeded; the process then ends nonzero. Nothing of the
 * work that did not end (requests, errors, provider text) reaches it. */
export function stopFailureMessage(phase: EmrStopPhase): string {
  const step: EmrStopPhase = Object.prototype.hasOwnProperty.call(STOP_PHASES, phase) ? phase : 'ledger';
  return `종료 실패(${step}): ${STOP_PHASES[step]}. 프로세스를 끝냅니다.`;
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
