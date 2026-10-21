import { TextDecoder } from 'node:util';
import { choice, freeze, integer, object, sha256, string, utc } from '../emr-contract/validation';
import type { CommitBinding, StreamSeal } from './seal';
import { JOURNAL_CAUSES, JOURNAL_KINDS, type JournalKind, type JournalRecord } from './journal-file';
import { EMR_STATE_FRAME_MAX_BYTES, EMR_STATE_MAX_OPERATIONS, EMR_STATE_MAX_SCOPES,
  EMR_STATE_MAX_SESSIONS } from './limits';

export const STATE_PROTOCOL_VERSION = 1 as const;
export const STATE_OPERATIONS = ['hello', 'begin', 'reserve', 'confirm-bundle', 'lookup-outcome',
  'journal-record', 'journal-find', 'acknowledge', 'expiry-prefix', 'end', 'status'] as const;
export type StateOperation = typeof STATE_OPERATIONS[number];
export type StateRole = 'api' | 'retention';
export const STATE_ERROR_CODES = ['NOT_READY', 'STOPPING', 'OVERLOADED', 'PROTOCOL', 'FORBIDDEN',
  'EPOCH', 'SESSION', 'SCOPE', 'CONFLICT', 'UNAVAILABLE', 'TIMEOUT', 'DURABILITY', 'CAPACITY', 'CLOSED'] as const;
export type StateErrorCode = typeof STATE_ERROR_CODES[number];
export type StateOutcome = 'not-started' | 'unknown' | 'conflict' | 'unavailable';
export class StateProtocolError extends Error {
  constructor(readonly code: StateErrorCode, readonly outcome: StateOutcome) {
    super(code); this.name = 'StateProtocolError';
  }
}
export interface ChainIds { viewing: string; history: string }
export interface DatabaseIdentity { database: string; oid: number; address: string | null; port: number | null }
export interface PairIdentity { instanceId: string; chains: ChainIds; database: DatabaseIdentity }
export interface ClientIdentity { clientInstanceId: string; chains: ChainIds }
export interface ScopeIdentity extends ClientIdentity { scope: string }
export type Reservation = Omit<CommitBinding, 'generation' | 'proofDigest'>;
export interface ExpiryPrefix { seal: StreamSeal; anchor: { sequence: number; hash: string }; count: number }
export interface BundleIdentity {
  eventId: string | null;
  requiredStreams: ('viewing' | 'history')[];
  bindings: CommitBinding[];
}
export interface SealedBundleProof {
  v: 1;
  serviceEpoch: string;
  eventId: string | null;
  requiredStreams: ('viewing' | 'history')[];
  entries: (CommitBinding & { sealed: StreamSeal })[];
}
export interface HelloResult extends PairIdentity { ready: true; session: string }
export interface StateValues {
  hello: { protocol: 1; clientInstanceId: string };
  begin: ClientIdentity;
  reserve: ScopeIdentity & { binding: Reservation; prefix: ExpiryPrefix | null };
  'confirm-bundle': ScopeIdentity & BundleIdentity;
  'lookup-outcome': ScopeIdentity & BundleIdentity;
  'journal-record': ScopeIdentity & { id: string; kind: JournalKind; body: Record<string, string | number> };
  'journal-find': ScopeIdentity & { id: string };
  acknowledge: ScopeIdentity & { proof: SealedBundleProof; bindings: CommitBinding[] };
  'expiry-prefix': ScopeIdentity & { through: number };
  end: ScopeIdentity;
  status: ClientIdentity;
}
export interface StateResults {
  hello: HelloResult;
  begin: { scope: string };
  reserve: CommitBinding;
  'confirm-bundle': SealedBundleProof;
  'lookup-outcome': { outcome: 'committed-and-sealed'; proof: SealedBundleProof } |
    { outcome: 'fenced-not-committed'; bindings: CommitBinding[] } | { outcome: 'unresolved' | 'conflict' };
  'journal-record': JournalRecord;
  'journal-find': JournalRecord | null;
  acknowledge: { status: 'acknowledged' | 'already-acknowledged' };
  'expiry-prefix': ExpiryPrefix;
  end: { status: 'ended' | 'already-ended' };
  status: { state: 'ready' | 'stopping'; chains: ChainIds; sealed: { viewing: StreamSeal; history: StreamSeal };
    sessions: number; scopes: number; operations: number; journalRecords: number; pending: number };
}
export type StateRequest<O extends StateOperation = StateOperation> = O extends StateOperation ? {
  v: 1; requestId: string; serviceEpoch: string | null; session: string | null; workId: string | null;
  operation: O; value: StateValues[O];
} : never;
export type StateResponse<O extends StateOperation = StateOperation> = {
  v: 1; requestId: string; serviceEpoch: string; ok: true; result: StateResults[O];
} | { v: 1; requestId: string; serviceEpoch: string | null; ok: false;
  error: { code: StateErrorCode; outcome: StateOutcome } };

function uuid(value: unknown): string {
  const result = string(value);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(result)) throw new Error('uuid');
  return result;
}
function token(value: unknown): string {
  const result = string(value);
  if (!/^[0-9a-f]{64}$/.test(result)) throw new Error('token');
  return result;
}
function text(value: unknown): string {
  const result = string(value);
  if (result.includes('\0') || Buffer.byteLength(result, 'utf8') > EMR_STATE_FRAME_MAX_BYTES) throw new Error('text');
  return result;
}
function chains(value: unknown): ChainIds {
  const v = object(value, ['viewing', 'history']);
  return { viewing: uuid(v.viewing), history: uuid(v.history) };
}
function position(value: unknown): { sequence: number; hash: string } {
  const v = object(value, ['sequence', 'hash']);
  return { sequence: integer(v.sequence), hash: sha256(v.hash) };
}
function frontier(value: unknown): StreamSeal {
  const v = object(value, ['chainId', 'sequence', 'hash']);
  return { chainId: uuid(v.chainId), sequence: integer(v.sequence), hash: sha256(v.hash) };
}
function prefix(value: unknown): ExpiryPrefix {
  const v = object(value, ['seal', 'anchor', 'count']);
  const result = { seal: frontier(v.seal), anchor: position(v.anchor), count: integer(v.count) };
  if (result.anchor.sequence > result.seal.sequence || result.count > result.anchor.sequence) throw new Error('prefix');
  return result;
}
const bindingKeys = ['stream', 'chainId', 'attemptId', 'bundleId', 'kind', 'eventId', 'sequence',
  'previousHash', 'hash', 'contentSha256'] as const;
function binding(value: unknown, reserved: false): Reservation;
function binding(value: unknown, reserved: true): CommitBinding;
function binding(value: unknown, reserved: boolean): Reservation | CommitBinding {
  const v = object(value, reserved ? [...bindingKeys, 'generation', 'proofDigest'] : bindingKeys);
  const result: Reservation = { stream: choice(v.stream, ['viewing', 'history'] as const), chainId: uuid(v.chainId),
    attemptId: text(v.attemptId), bundleId: text(v.bundleId), kind: choice(v.kind, ['access', 'history', 'expiry'] as const),
    eventId: v.eventId === null ? null : text(v.eventId), sequence: integer(v.sequence, 1),
    previousHash: sha256(v.previousHash), hash: sha256(v.hash), contentSha256: sha256(v.contentSha256) };
  if (result.kind === 'expiry' ? result.stream !== 'viewing' || result.eventId !== null :
    result.eventId === null || (result.kind === 'history') !== (result.stream === 'history')) throw new Error('binding');
  return reserved ? { ...result, generation: integer(v.generation, 1), proofDigest: v.proofDigest === null ? null : sha256(v.proofDigest) } : result;
}
export function parseCommitBinding(value: unknown): CommitBinding { return binding(value, true); }
function streamSet(value: unknown): ('viewing' | 'history')[] {
  if (!Array.isArray(value) || !(value.length === 1 && value[0] === 'viewing' ||
    value.length === 2 && value[0] === 'viewing' && value[1] === 'history')) throw new Error('streams');
  return [...value];
}
function bindings(value: unknown): CommitBinding[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) throw new Error('bindings');
  const result = value.map(v => binding(v, true));
  streamSet(result.map(b => b.stream));
  return result;
}
function bundle(v: Record<string, any>): BundleIdentity {
  const result = { eventId: v.eventId === null ? null : text(v.eventId), requiredStreams: streamSet(v.requiredStreams), bindings: bindings(v.bindings) };
  if (result.bindings.length !== result.requiredStreams.length || result.bindings.some((b, i) =>
    b.stream !== result.requiredStreams[i] || b.eventId !== result.eventId)) throw new Error('bundle');
  // B1 expiry checkpoints have no access event ID and can only occupy the viewing stream.
  if (result.eventId === null && (result.bindings.length !== 1 || result.bindings[0].kind !== 'expiry')) throw new Error('expiry-bundle');
  return result;
}
export function parseSealedBundleProof(value: unknown): SealedBundleProof {
  const v = object(value, ['v', 'serviceEpoch', 'eventId', 'requiredStreams', 'entries']);
  if (v.v !== STATE_PROTOCOL_VERSION || !Array.isArray(v.entries) || v.entries.length < 1 || v.entries.length > 2) throw new Error('proof');
  const entries = v.entries.map(raw => {
    const e = object(raw, [...bindingKeys, 'generation', 'proofDigest', 'sealed']);
    const { sealed: rawSeal, ...rawBinding } = e;
    const b = binding(rawBinding, true), sealed = frontier(rawSeal);
    if (sealed.chainId !== b.chainId || sealed.sequence < b.sequence ||
      sealed.sequence === b.sequence && sealed.hash !== b.hash) throw new Error('coverage');
    return { ...b, sealed };
  });
  const identity = bundle({ ...v, bindings: entries.map(({ sealed: _, ...b }) => b) });
  return { v: 1, serviceEpoch: uuid(v.serviceEpoch), eventId: identity.eventId, requiredStreams: identity.requiredStreams, entries };
}
const proof = parseSealedBundleProof;
function journalBody(kind: JournalKind, value: unknown): Record<string, string | number> {
  const v = object(value, JOURNAL_KINDS[kind]), result = {} as Record<string, string | number>;
  for (const key of JOURNAL_KINDS[kind]) result[key] = key === 'fromSequence' || key === 'toSequence' ? integer(v[key]) :
    key === 'toHash' || key === 'contentSha256' ? sha256(v[key]) : key === 'cause' ? choice(v[key], JOURNAL_CAUSES) : text(v[key]);
  return result;
}
function journal(value: unknown): JournalRecord {
  const v = object(value, ['id', 'kind', 'at', 'body']);
  const kind = choice(v.kind, Object.keys(JOURNAL_KINDS) as JournalKind[]);
  const result = { id: text(v.id), kind, at: utc(v.at), body: journalBody(kind, v.body) };
  if (Buffer.byteLength(JSON.stringify(result)) > 4096) throw new Error('journal-size');
  return result;
}
function identity(v: Record<string, any>): ClientIdentity { return { clientInstanceId: uuid(v.clientInstanceId), chains: chains(v.chains) }; }
function scope(v: Record<string, any>): ScopeIdentity { return { ...identity(v), scope: token(v.scope) }; }
const identityKeys = ['clientInstanceId', 'chains'];
const scopeKeys = [...identityKeys, 'scope'];

/** Data validation precedes dispatch. The listening endpoint supplies role; it is never a wire field. */
export function parseStateRequest(value: unknown, role: StateRole): StateRequest {
  try {
    const r = object(value, ['v', 'requestId', 'serviceEpoch', 'session', 'workId', 'operation', 'value']);
    if (r.v !== STATE_PROTOCOL_VERSION) throw new Error('version');
    const operation = choice(r.operation, STATE_OPERATIONS);
    const base = { v: 1 as const, requestId: uuid(r.requestId), operation,
      serviceEpoch: r.serviceEpoch === null ? null : uuid(r.serviceEpoch),
      session: r.session === null ? null : token(r.session), workId: r.workId === null ? null : uuid(r.workId) };
    if (operation === 'hello') {
      if (base.serviceEpoch !== null || base.session !== null || base.workId !== null) throw new Error('hello');
      const v = object(r.value, ['protocol', 'clientInstanceId']);
      if (v.protocol !== STATE_PROTOCOL_VERSION) throw new Error('version');
      return { ...base, operation, value: { protocol: 1, clientInstanceId: uuid(v.clientInstanceId) } };
    }
    if (base.serviceEpoch === null || base.session === null || (operation === 'status' ? base.workId !== null : base.workId === null)) throw new Error('authority');
    let v: Record<string, any>, result: unknown;
    switch (operation) {
      case 'begin': case 'status': v = object(r.value, identityKeys); result = identity(v); break;
      case 'end': v = object(r.value, scopeKeys); result = scope(v); break;
      case 'reserve':
        v = object(r.value, [...scopeKeys, 'binding', 'prefix']);
        result = { ...scope(v), binding: binding(v.binding, false), prefix: v.prefix === null ? null : prefix(v.prefix) };
        if (role !== 'retention' && (v.prefix !== null || v.binding.kind === 'expiry')) throw new StateProtocolError('FORBIDDEN', 'not-started');
        if ((v.binding.kind === 'expiry') !== (v.prefix !== null)) throw new Error('expiry-prefix');
        break;
      case 'confirm-bundle': case 'lookup-outcome':
        v = object(r.value, [...scopeKeys, 'eventId', 'requiredStreams', 'bindings']); result = { ...scope(v), ...bundle(v) }; break;
      case 'journal-record': {
        v = object(r.value, [...scopeKeys, 'id', 'kind', 'body']);
        const kind = choice(v.kind, Object.keys(JOURNAL_KINDS) as JournalKind[]);
        result = { ...scope(v), id: text(v.id), kind, body: journalBody(kind, v.body) };
        journal({ id: v.id, kind, body: v.body, at: '2000-01-01T00:00:00.000Z' });
        break;
      }
      case 'journal-find': v = object(r.value, [...scopeKeys, 'id']); result = { ...scope(v), id: text(v.id) }; break;
      case 'acknowledge':
        v = object(r.value, [...scopeKeys, 'proof', 'bindings']);
        result = { ...scope(v), proof: proof(v.proof), bindings: bindings(v.bindings) }; break;
      case 'expiry-prefix':
        if (role !== 'retention') throw new StateProtocolError('FORBIDDEN', 'not-started');
        v = object(r.value, [...scopeKeys, 'through']); result = { ...scope(v), through: integer(v.through, 1) }; break;
    }
    const checked = result as StateValues[Exclude<StateOperation, 'hello'>];
    const bound = operation === 'reserve' ? [(checked as StateValues['reserve']).binding] :
      ['confirm-bundle', 'lookup-outcome', 'acknowledge'].includes(operation) ? (checked as BundleIdentity).bindings : [];
    if (bound.some(b => b.chainId !== checked.chains[b.stream])) throw new Error('chain-binding');
    if (role !== 'retention' && bound.some(b => b.kind === 'expiry')) throw new StateProtocolError('FORBIDDEN', 'not-started');
    if (operation === 'acknowledge') {
      const ack = checked as StateValues['acknowledge'];
      sameBindings(ack.bindings, ack.proof.entries.map(({ sealed: _, ...b }) => b));
    }
    return freeze({ ...base, value: result }) as StateRequest;
  } catch (error) {
    if (error instanceof StateProtocolError) throw error;
    throw new StateProtocolError('PROTOCOL', 'not-started');
  }
}

function sameBindings(expected: readonly CommitBinding[], actual: readonly CommitBinding[]): void {
  if (expected.length !== actual.length || expected.some((b, i) =>
    [...bindingKeys, 'generation', 'proofDigest'].some(key => b[key] !== actual[i][key]))) throw new Error('bindings-differ');
}

function checkResultBinding(request: StateRequest, result: any): void {
  switch (request.operation) {
    case 'reserve':
      if (bindingKeys.some(key => request.value.binding[key] !== result[key])) throw new Error('reservation-differs');
      break;
    case 'confirm-bundle': case 'lookup-outcome': {
      const bundleProof = request.operation === 'confirm-bundle' ? result : result.outcome === 'committed-and-sealed' ? result.proof : null;
      if (bundleProof) {
        if (bundleProof.eventId !== request.value.eventId ||
          JSON.stringify(bundleProof.requiredStreams) !== JSON.stringify(request.value.requiredStreams)) throw new Error('event-differs');
        sameBindings(request.value.bindings, bundleProof.entries.map(({ sealed: _, ...b }) => b));
      } else if (result.outcome === 'fenced-not-committed') sameBindings(request.value.bindings, result.bindings);
      break;
    }
    case 'journal-record':
      if (result.id !== request.value.id || result.kind !== request.value.kind ||
        Object.keys(request.value.body).some(key => result.body[key] !== request.value.body[key])) throw new Error('journal-differs');
      break;
    case 'journal-find': if (result !== null && result.id !== request.value.id) throw new Error('journal-differs'); break;
    case 'expiry-prefix':
      if (result.anchor.sequence !== request.value.through || result.seal.chainId !== request.value.chains.viewing) throw new Error('prefix-differs');
      break;
    case 'status':
      if (result.chains.viewing !== request.value.chains.viewing || result.chains.history !== request.value.chains.history) throw new Error('chains-differ');
      break;
  }
}

function parseResult(operation: StateOperation, value: unknown): unknown {
  switch (operation) {
    case 'hello': {
      const v = object(value, ['ready', 'session', 'instanceId', 'chains', 'database']);
      const db = object(v.database, ['database', 'oid', 'address', 'port']);
      if (v.ready !== true || (db.port !== null && integer(db.port, 1) > 65535)) throw new Error('hello');
      return { ready: true, session: token(v.session), instanceId: text(v.instanceId), chains: chains(v.chains),
        database: { database: text(db.database), oid: integer(db.oid, 1), address: db.address === null ? null : text(db.address), port: db.port } };
    }
    case 'begin': return { scope: token(object(value, ['scope']).scope) };
    case 'reserve': return binding(value, true);
    case 'confirm-bundle': return proof(value);
    case 'lookup-outcome': {
      if (!value || typeof value !== 'object') throw new Error('outcome');
      const outcome = choice((value as any).outcome, ['committed-and-sealed', 'fenced-not-committed', 'conflict', 'unresolved'] as const);
      if (outcome === 'committed-and-sealed') return { outcome, proof: proof(object(value, ['outcome', 'proof']).proof) };
      if (outcome === 'fenced-not-committed') return { outcome, bindings: bindings(object(value, ['outcome', 'bindings']).bindings) };
      object(value, ['outcome']); return { outcome };
    }
    case 'journal-record': return journal(value);
    case 'journal-find': return value === null ? null : journal(value);
    case 'acknowledge': return { status: choice(object(value, ['status']).status, ['acknowledged', 'already-acknowledged'] as const) };
    case 'end': return { status: choice(object(value, ['status']).status, ['ended', 'already-ended'] as const) };
    case 'expiry-prefix': return prefix(value);
    case 'status': {
      const v = object(value, ['state', 'chains', 'sealed', 'sessions', 'scopes', 'operations', 'journalRecords', 'pending']);
      const s = object(v.sealed, ['viewing', 'history']);
      if (integer(v.sessions) > EMR_STATE_MAX_SESSIONS || integer(v.scopes) > EMR_STATE_MAX_SCOPES ||
        integer(v.operations) > EMR_STATE_MAX_OPERATIONS) throw new Error('capacity');
      const ids = chains(v.chains), sealed = { viewing: frontier(s.viewing), history: frontier(s.history) };
      if (ids.viewing !== sealed.viewing.chainId || ids.history !== sealed.history.chainId) throw new Error('chains');
      return { state: choice(v.state, ['ready', 'stopping'] as const), chains: ids, sealed,
        sessions: v.sessions, scopes: v.scopes, operations: v.operations, journalRecords: integer(v.journalRecords), pending: integer(v.pending) };
    }
  }
}

/** Matching a response is not receipt authority. The caller still verifies the event's complete proof locally. */
export function parseStateResponse<O extends StateOperation>(value: unknown, request: StateRequest<O>): StateResponse<O> {
  try {
    if (!value || typeof value !== 'object' || typeof (value as any).ok !== 'boolean') throw new Error('response');
    const r = object(value, (value as any).ok ? ['v', 'requestId', 'serviceEpoch', 'ok', 'result'] : ['v', 'requestId', 'serviceEpoch', 'ok', 'error']);
    if (r.v !== STATE_PROTOCOL_VERSION || uuid(r.requestId) !== request.requestId) throw new Error('correlation');
    const epoch = r.serviceEpoch === null ? null : uuid(r.serviceEpoch);
    if (request.serviceEpoch !== null && epoch !== request.serviceEpoch) throw new StateProtocolError('EPOCH', 'unknown');
    if (!r.ok) {
      const error = object(r.error, ['code', 'outcome']);
      return { v: 1, requestId: r.requestId, serviceEpoch: epoch, ok: false, error: {
        code: choice(error.code, STATE_ERROR_CODES), outcome: choice(error.outcome, ['not-started', 'unknown', 'conflict', 'unavailable'] as const) } };
    }
    if (epoch === null) throw new Error('epoch');
    const result: any = parseResult(request.operation, r.result);
    checkResultBinding(request as StateRequest, result);
    // The envelope authenticates the current admitted epoch above. The canonical
    // proof's epoch is historical evidence and survives a service replacement.
    return freeze({ v: 1, requestId: r.requestId, serviceEpoch: epoch, ok: true, result }) as StateResponse<O>;
  } catch (error) {
    if (error instanceof StateProtocolError) throw error;
    throw new StateProtocolError('PROTOCOL', 'unknown');
  }
}

export function encodeStateFrame(value: unknown): Buffer {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('json');
    const frame = Buffer.from(encoded + '\n', 'utf8');
    if (frame.length > EMR_STATE_FRAME_MAX_BYTES) throw new Error('size');
    return frame;
  } catch { throw new StateProtocolError('PROTOCOL', 'not-started'); }
}

/** Per-operation sockets use a write half-close before dispatch: a second delayed frame cannot race a mutation.
 * A hello has no mutation authority and keeps its control socket; any later byte invalidates that session. */
export class StateFrameReader {
  private bytes = Buffer.alloc(0);
  private complete = false;
  push(part: Uint8Array): boolean {
    if (!part.length) return this.complete;
    if (this.complete || this.bytes.length + part.length > EMR_STATE_FRAME_MAX_BYTES) throw new StateProtocolError('PROTOCOL', 'not-started');
    this.bytes = Buffer.concat([this.bytes, part]);
    const lf = this.bytes.indexOf(10);
    if (lf !== -1) {
      if (lf !== this.bytes.length - 1) throw new StateProtocolError('PROTOCOL', 'not-started');
      this.complete = true;
    }
    return this.complete;
  }
  finish(): unknown {
    try {
      if (!this.complete) throw new Error('truncated');
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(this.bytes.subarray(0, -1));
      return JSON.parse(text);
    } catch { throw new StateProtocolError('PROTOCOL', 'not-started'); }
  }
}
