// Existing B1 per-transaction/pool limits; D1770 first-site pending bound.
export const EMR_TX_MAX_WAIT_MS = 10000;
export const EMR_TX_TIMEOUT_MS = 15000;
export const EMR_APPEND_LANES = 4;
export const EMR_VERIFY_RESERVE = 2;
export const EMR_APPEND_POOL_SIZE = EMR_APPEND_LANES + EMR_VERIFY_RESERVE;
export const EMR_PENDING_LIMIT = 128;
