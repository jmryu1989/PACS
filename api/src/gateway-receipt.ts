/**
 * S4-U3 Gateway 전송 영수증 (축 C) — 순수 규칙.
 *
 * 영수증은 "Gateway가 **보고 시점에** 자기 큐에서 본 것"이다. `phase=complete`와 `M==N`은 그 시점에
 * 들고 있던 SOP 집합을 다 보냈다는 뜻일 뿐, 검사가 끝났다거나 영상이 다 왔다는 뜻이 아니다
 * (늦게 온 인스턴스는 agent 큐를 다시 연다). 그래서 이 모듈은 수신·완료 판정을 하지 않는다.
 *
 * 본문은 닫힌 키 집합이다. 기관은 자격증명에서만 오고, 시각은 KIN 서버가 받은 시각만 쓴다 —
 * agent의 시계는 순서에 쓰지 않는다. 순서는 (epoch, seq) 뿐이다.
 */
export const GATEWAY_PHASES = ['pending', 'announcing', 'sending', 'retry', 'failed', 'complete'] as const;
export type GatewayPhase = typeof GATEWAY_PHASES[number];

/** errorCode가 있는 단계. 나머지 단계에서 errorCode는 반드시 null이다. */
export const GATEWAY_ERROR_PHASES: readonly GatewayPhase[] = ['retry', 'failed'];

/**
 * gateway/agent/agent.py `GATEWAY_ERROR_CODES`의 값 전부와 fallback `other`. 자유 문구는 받지 않는다 —
 * PHI가 섞이지 않았다는 증명을 문자열 검사로는 할 수 없다. 두 목록의 일치는 순수 시험이 지킨다.
 */
export const GATEWAY_ERROR_CODES = [
  'configuration', 'local_orthanc_unreachable', 'local_orthanc_http', 'local_study_lookup',
  'local_instance_metadata', 'local_duplicate_sop', 'local_change_invalid', 'token_unreachable', 'token_http',
  'token_invalid', 'cloud_unreachable', 'cloud_auth', 'announce_http', 'stow_http', 'stow_response_invalid',
  'stow_sop_failed', 'local_sop_missing', 'instance_exceeds_budget', 'batch_exceeds_budget', 'other',
] as const;
export type GatewayErrorCode = typeof GATEWAY_ERROR_CODES[number];

export const GATEWAY_RECEIPT_KEYS = ['studyUid', 'phase', 'attempt', 'successCount', 'localCount', 'errorCode', 'epoch', 'seq'] as const;

/** 다른 epoch 사건의 감사는 검사당 이 창에 한 건이다. 거절 자체는 창과 무관하게 매번 한다. */
export const GATEWAY_EPOCH_INCIDENT_WINDOW_MS = 60 * 60 * 1000;

export class GatewayReceiptInputError extends Error {}

export interface GatewayReceipt {
  studyUid: string;
  phase: GatewayPhase;
  attempt: number;
  successCount: number;
  localCount: number;
  errorCode: GatewayErrorCode | null;
  epoch: string;
  seq: number;
}

const EPOCH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const member = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (list as readonly string[]).includes(value);

/** 닫힌 본문 검사. 거절 이유는 칸 이름뿐이다 — 본문 값을 되돌려 말하지 않는다. */
export function parseGatewayReceipt(body: unknown): GatewayReceipt {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new GatewayReceiptInputError('body');
  const keys = Object.keys(body);
  if (keys.length !== GATEWAY_RECEIPT_KEYS.length || !keys.every(key => member(GATEWAY_RECEIPT_KEYS, key)))
    throw new GatewayReceiptInputError('keys');
  const { studyUid, phase, attempt, successCount, localCount, errorCode, epoch, seq } = body as Record<string, unknown>;
  // announce와 같은 UID 규칙이다. 예고할 수 있었던 검사는 보고도 할 수 있다.
  if (typeof studyUid !== 'string' || !/^[0-9.]+$/.test(studyUid)) throw new GatewayReceiptInputError('studyUid');
  if (!member(GATEWAY_PHASES, phase)) throw new GatewayReceiptInputError('phase');
  if (!count(attempt)) throw new GatewayReceiptInputError('attempt');
  if (!count(successCount)) throw new GatewayReceiptInputError('successCount');
  if (!count(localCount)) throw new GatewayReceiptInputError('localCount');
  if (!count(seq)) throw new GatewayReceiptInputError('seq');
  if (successCount > localCount) throw new GatewayReceiptInputError('successCount');
  if (phase === 'complete' && successCount !== localCount) throw new GatewayReceiptInputError('complete');
  let code: GatewayErrorCode | null = null;
  if (GATEWAY_ERROR_PHASES.includes(phase)) {
    if (!member(GATEWAY_ERROR_CODES, errorCode)) throw new GatewayReceiptInputError('errorCode');
    code = errorCode;
  } else if (errorCode !== null) throw new GatewayReceiptInputError('errorCode');
  if (typeof epoch !== 'string' || !EPOCH.test(epoch)) throw new GatewayReceiptInputError('epoch');
  return { studyUid, phase, attempt, successCount, localCount, errorCode: code, epoch, seq };
}

/** 저장된 영수증을 숫자로 읽은 모양(BIGINT 칸은 저장 전에 안전 정수로 검사됐다). */
export interface StoredGatewayReceipt {
  epoch: string;
  seq: number;
  phase: string;
  attempt: number;
  successCount: number;
  localCount: number;
  errorCode: string | null;
}

export function storedGatewayReceipt(row: any): StoredGatewayReceipt {
  return {
    epoch: String(row.epoch), seq: Number(row.seq), phase: String(row.phase), attempt: Number(row.attempt),
    successCount: Number(row.successCount), localCount: Number(row.localCount), errorCode: row.errorCode ?? null,
  };
}

export type GatewayReceiptDecision =
  | { kind: 'first' }                          // 저장, 최초 연결 감사 1건
  | { kind: 'advance'; transition: boolean }   // 저장, complete/failed로 바뀌었을 때만 감사
  | { kind: 'duplicate' }                      // 같은 (epoch, seq, 본문): 쓰기·감사 없음
  | { kind: 'stale' }                          // 같은 epoch의 낮은 seq: 쓰기 없음
  | { kind: 'conflict' }                       // 같은 (epoch, seq)에 다른 본문: 409
  | { kind: 'epoch' };                         // 다른 epoch: 409, 저장 불변 (H-1 HOLD)

const TERMINAL: readonly string[] = ['complete', 'failed'];

/**
 * 순서·멱등 규칙. 다른 epoch은 seq가 얼마든 **교체하지 않는다** — 승인된 회수·교체 규칙(H-1)이
 * 생기기 전에는 인증 없는 자동 전환 경로가 없다. 처음 보는 epoch은 그 검사에 기록이 없을 때뿐이다.
 */
export function decideGatewayReceipt(stored: StoredGatewayReceipt | null, next: GatewayReceipt): GatewayReceiptDecision {
  if (!stored) return { kind: 'first' };
  if (stored.epoch !== next.epoch) return { kind: 'epoch' };
  if (next.seq < stored.seq) return { kind: 'stale' };
  if (next.seq === stored.seq) {
    const same = stored.phase === next.phase && stored.attempt === next.attempt && stored.successCount === next.successCount
      && stored.localCount === next.localCount && stored.errorCode === next.errorCode;
    return same ? { kind: 'duplicate' } : { kind: 'conflict' };
  }
  return { kind: 'advance', transition: next.phase !== stored.phase && TERMINAL.includes(next.phase) };
}

/** 워크리스트 축 C. 없으면 null — 영수증이 없는 검사는 영구히 정상이다(실패·오프라인이 아니다). */
export function projectGatewayReceipt(row: any) {
  if (!row) return null;
  const s = storedGatewayReceipt(row);
  return {
    phase: s.phase, successCount: s.successCount, localCount: s.localCount, attempt: s.attempt,
    errorCode: s.errorCode, serverReceivedAt: new Date(row.receivedAt).toISOString(), agentSeq: s.seq, epoch: s.epoch,
  };
}
