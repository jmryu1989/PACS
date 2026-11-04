/*
 * MIP-OUTPUT-02 (2026-11-04): the one owner of the API's HTTP connections to Orthanc.
 *
 * Why: Orthanc 1.12.5 answers `Keep-Alive: timeout=1`, and Node's fetch keeps a connection only for the hint minus its
 * 2 s threshold - never here - so every API->Orthanc request opened a new connection and the API's network namespace
 * filled with TIME_WAIT sockets toward orthanc:8042 until connect() failed with EADDRNOTAVAIL (VM runs mo2-opus-20261104a
 * and b: 6/6 failures of test_volume_mip_output 02 with the client port range at 10,000, 3/3 passes once Orthanc's hint
 * was 5 s). config/orthanc.json now sets KeepAliveTimeout 5, and these pools reuse a connection for 3 s of the 5 s,
 * returning it before Orthanc closes it. Reuse alone would keep an unbounded number of idle connections, and CivetWeb
 * holds one of Orthanc's HttpThreadsCount (50) worker threads for every open connection, so the pools are finite.
 *
 * Two lanes, because a finite pool can deadlock a request that holds a response while it asks Orthanc again: relay()
 * keeps an image answer unread while its delivery record confirms the study (studyRevision/studyPatientIdentity). With
 * one pool, as many held relays as connections would leave the confirmations waiting for a connection none of them
 * returns. `body` carries the requests whose answer may stay open while the caller does other work (relays, streamed
 * originals and frames, digests, uploads); `check` carries the requests whose whole answer is read before anything else
 * is asked (JSON, metadata, lookups, identity and revision reads). A `check` request never waits on another Orthanc
 * request while holding its connection, so the `check` lane always drains and the held `body` requests finish.
 *
 * Budget against Orthanc's 50 worker threads: 8 + 8 connections per API process (one process per installation in
 * docker-compose.yml), the rest for nginx's direct reads (/worklist, /ohif assets, /system, /statistics; one short
 * connection per request, no upstream keep-alive) and the operator's own reads. A deployment that runs more API
 * processes against one Orthanc multiplies the 16.
 *
 * Only a response read to its end returns its connection; a cancelled or failed body still ends that connection at once
 * (the callers' existing cancel paths). A request waits in its lane's queue under the caller's own signal and deadline;
 * past QUEUE_LIMIT waiting requests a lane refuses at once, as a failure to reach Orthanc, instead of growing without
 * bound. The calls stay the global fetch with a dispatcher, so the response, body and abort semantics are unchanged.
 */
import { Pool } from 'undici';

export type OrthancLane = 'check' | 'body';

const CONNECTIONS: Readonly<Record<OrthancLane, number>> = { check: 8, body: 8 };
const QUEUE_LIMIT = 1024;
// 5 s Orthanc hint - 2 s threshold = 3 s, capped at 3 s also when an answer carries no hint.
const KEEP_ALIVE = { keepAliveTimeout: 3000, keepAliveMaxTimeout: 3000, keepAliveTimeoutThreshold: 2000 } as const;

const lanes = new Map<string, Record<OrthancLane, Pool>>();

function lane(origin: string, which: OrthancLane): Pool {
  let pools = lanes.get(origin);
  if (!pools) {
    const pool = (connections: number) => new Pool(origin, { connections, pipelining: 1, ...KEEP_ALIVE });
    lanes.set(origin, pools = { check: pool(CONNECTIONS.check), body: pool(CONNECTIONS.body) });
  }
  return pools[which];
}

/** The lane's refusal when it is full: the shape of fetch's own failure to connect, so every caller maps it as one. */
function busy(which: OrthancLane): TypeError {
  return Object.assign(new TypeError('fetch failed'),
    { cause: Object.assign(new Error(`Orthanc ${which} connections busy`), { code: 'KIN_ORTHANC_BUSY' }) });
}

/** fetch() to Orthanc through the lane's pool of its origin (one pair per origin per process). */
export function orthancFetch(url: string, init: RequestInit, which: OrthancLane): Promise<Response> {
  const pool = lane(new URL(url).origin, which);
  if (pool.stats.pending >= QUEUE_LIMIT) return Promise.reject(busy(which));
  return fetch(url, { ...init, dispatcher: pool } as RequestInit);
}
