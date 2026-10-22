/** A transaction waiting for a connection must not inherit Prisma's 2 s default.
 * Admission keeps head-lock waiters out of the API pool; these bounds cover
 * finite IO/recovery delays, not an alternative to admission. Startup verifies
 * the retained chain and therefore has a separate, longer execution budget.
 * Client-only job IPC expires well before its deleting transaction does.
 */
export const EMR_TX_MAX_WAIT_MS = 10000;
export const EMR_TX_TIMEOUT_MS = 15000;
export const EMR_RECOVERY_TIMEOUT_MS = 30000;
export const EMR_STATE_IPC_TIMEOUT_MS = 2000;
/** Includes the terminating LF. These are admission bounds, never queue sizes. */
export const EMR_STATE_FRAME_MAX_BYTES = 64 * 1024;
export const EMR_STATE_MAX_SESSIONS = 16;
export const EMR_STATE_MAX_SCOPES = 128;
export const EMR_STATE_MAX_OPERATIONS = 64;
export const EMR_STATE_VERIFY_CONCURRENCY = 2;
export const EMR_DRAIN_TIMEOUT_MS = 10000;
export const EMR_CLEANUP_TIMEOUT_MS = 5000;
export const EMR_OWNER_RETRIES = 3;
export const EMR_OWNER_RETRY_MS = 25;

/** Bound head-lock waiters before acquiring connections. Two pool slots remain
 * available to receipt verification even when all append lanes are occupied.
 * This is a dedicated EMR client: unrelated API queries cannot consume its
 * reserve. One lane uses at most one connection, so lanes + reserve is enough;
 * explicitly configured smaller pools reduce lanes while retaining the reserve. */
export const EMR_APPEND_LANES = 4;
export const EMR_VERIFY_RESERVE = 2;
export const EMR_APPEND_POOL_SIZE = EMR_APPEND_LANES + EMR_VERIFY_RESERVE;

/** Cold replays may hash at most this many rows through the external seal.
 * Beyond this bound they fail closed (SealUnavailable/replay-verification-limit),
 * without occupying a DB connection. Startup still verifies the entire retained
 * chain; a far historical replay requires an explicit offline verification flow.
 * This cap never affects a new committed append or startup recovery.
 */
export const EMR_REPLAY_VERIFY_ROWS = 1000;

/** EMR-B2 (c) v4: how often an idle v4 owner looks at its periodic complete check (one bounded step per tick when
 * the check is due or in progress; the 24-hour period itself is the format's V4_FULL_CHECK_MS). */
export const EMR_FULL_CHECK_TICK_MS = 60_000;
