/**
 * S4-U4 Now Retry — 순수 규칙.
 *
 * 사람은 `retry` 상태 검사에 "지금 다시 시도"를 **요청**만 한다. KIN은 요청을 남기고 Gateway가 가져간다
 * (병원으로 여는 인바운드 포트는 없다). Gateway는 자기 큐의 next_at만 당긴다 — attempt·lastError·성공 SOP는
 * 그대로다. 요청은 저장된 `retry` 영수증의 (epoch, seq) 하나에 묶이고, Gateway가 더 새 상태를 보고하면
 * 더는 전달되지 않는 기록이 된다. 확인 경로(ack)는 없다. 그래서 HTTP 성공은 "저장됨"이지 "재시도됨"이 아니다.
 *
 * `failed`는 F-01이다. 유일한 생산자가 바이트 상한을 넘는 단일 인스턴스라 같은 바이트로는 성공할 수 없다.
 * 거절만 하고 여기서 다시 열지 않는다(H-2).
 */
export const GATEWAY_RETRY_POLL_LIMIT = 100;

export const GATEWAY_RETRY_INVALID = 'GATEWAY_RETRY_INVALID';
export const GATEWAY_RETRY_POLL_INVALID = 'GATEWAY_RETRY_POLL_INVALID';
export const GATEWAY_RETRY_NOT_RETRY = 'GATEWAY_RETRY_NOT_RETRY';
export const GATEWAY_RETRY_UNSUPPORTED_F01 = 'GATEWAY_RETRY_UNSUPPORTED_F01';
export const GATEWAY_RETRY_BUSY = 'GATEWAY_RETRY_BUSY';

export class GatewayRetryInputError extends Error {}

/** gateway-receipt.ts의 EPOCH와 같은 글자다 — 소문자 UUID만 받는다. */
const EPOCH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * 닫힌 빈 본문. epoch·seq·사유·기관을 받지 않는다 — 무엇에 묶일지는 서버가 저장된 영수증에서 고른다.
 * 본문 없이 온 POST는 파서에 따라 undefined·null·{}로 보이므로 셋 다 같은 "빈 본문"이다.
 */
export function parseGatewayRetryRequestBody(body: unknown): void {
  if (body === undefined || body === null) return;
  if (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0)
    throw new GatewayRetryInputError('body');
}

/**
 * 닫힌 조회. 키는 `epoch` 하나, 값은 문자열 하나다. 쿼리 파서는 `?epoch=a&epoch=b`를 배열로,
 * `?epoch[x]=y`를 객체로 만들므로 둘 다 여기서 거절된다.
 */
export function parseGatewayRetryPoll(query: unknown): string {
  if (!query || typeof query !== 'object' || Array.isArray(query)) throw new GatewayRetryInputError('query');
  const keys = Object.keys(query);
  if (keys.length !== 1 || keys[0] !== 'epoch') throw new GatewayRetryInputError('query');
  const epoch = (query as Record<string, unknown>).epoch;
  if (typeof epoch !== 'string' || !EPOCH.test(epoch)) throw new GatewayRetryInputError('epoch');
  return epoch;
}

export type GatewayRetryDecision = 'eligible' | 'not_retry' | 'unsupported_f01';

/** 요청을 묶을 수 있는 저장 영수증은 `retry` 하나다. 영수증이 없거나 다른 단계면 not_retry, `failed`는 F-01. */
export function decideGatewayRetryRequest(receipt: { phase: string } | null): GatewayRetryDecision {
  if (!receipt) return 'not_retry';
  if (receipt.phase === 'failed') return 'unsupported_f01';
  return receipt.phase === 'retry' ? 'eligible' : 'not_retry';
}
