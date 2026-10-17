import { randomUUID } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import type { EvidenceFact, ImmutableIdentity } from '../emr-contract/access-event';
import { refuse } from '../emr-contract/validation';
import { trustablePeer } from './application';
import type { EmrApplicationRuntime } from './application';
import { ingressAddress, knownIdentity, verifiedIdentityClaims } from './contract';

/**
 * EMR-B2-BASE: the verified facts of one admitted member request, for the readers that record what they served (Module A,
 * later C2/I-B2). Only AuthGuard's final member success captures them (AuthService.captureEmrRequest), from the payload it
 * verified and the rights it read from the database - never from req.actor/roles/institution/sub, a header or the body.
 * They are bound to that very request object and live as long as its response: a clone, a spread, a JSON copy or another
 * object has none, and after the response finished or closed or the request was aborted every read is refused.
 * Capture does no IO. The first read resolves the immutable identity (B1, issuer + subject) and the ingress address
 * (B1 ingressAddress over the deployment proxy's resolved addresses) once, with one server request ID; repeated reads of
 * the same request share that result, other requests never do. No token, cookie, session secret or key is a fact.
 */
export interface EmrAuthenticatedRequestFacts {
  readonly identity: ImmutableIdentity;
  readonly kind: 'member';
  readonly roles: readonly string[];
  readonly institutionId: string;
  readonly rightsVersion: number;
  readonly authMethod: 'session' | 'bearer';
  /** The admitted session's non-secret reference (AuthService.sessionRef of its sid); null for a bearer call (SD-2). */
  readonly sessionRef: string | null;
  readonly requestId: string;
  readonly trustedProxyIp: EvidenceFact<{ address: string; source: 'trusted-proxy' }>;
  /** The immutable ID of a current member of the same issuer, or a closed refusal; a subject is never minted. */
  member(subject: string): Promise<ImmutableIdentity>;
}
export interface EmrAuthenticatedRequestSource {
  facts(request: unknown): Promise<Readonly<EmrAuthenticatedRequestFacts>>;
}

/** What AuthGuard verified at the end of its member path: payload issuer/subject/name and the final DB rights. */
export interface EmrVerifiedAdmission {
  readonly issuer: string;
  readonly subject: string;
  readonly displayName: string | null;
  readonly roles: readonly string[];
  readonly institutionId: string;
  readonly rightsVersion: number;
  readonly authMethod: 'session' | 'bearer';
  readonly sessionRef: string | null;
}
export type EmrRequestCapture = (request: unknown, response: unknown, admission: EmrVerifiedAdmission) => void;
/** Resolves when the subject holds current, approved, non-suspended rights with an institution; else a closed refusal. */
export type EmrMemberCheck = (subject: string) => Promise<void>;
export type EmrPeerLookup = (host: string) => Promise<readonly { address: string }[]>;

// Bounded resolution of the proxy's addresses: a fresh answer serves 5 s; a verified set stays usable for 60 s while a new
// lookup gets 200 ms; without one a request waits 500 ms at most; a lookup older than 5 s is abandoned for a new one.
const PEER_FRESH_MS = 5000;
const PEER_STALE_MS = 60_000;
const PEER_WAIT_MS = 200;
const PEER_COLD_WAIT_MS = 500;
const PEER_LOOKUP_ABANDON_MS = 5000;

/** Only a verified non-empty answer replaces the set, and an older lookup's late answer never replaces a newer one. A
 * failed, empty or expired resolution leaves no trusted peer: the address is then unresolved/not-observed, never a guess. */
class TrustedProxyPeers {
  private cache: { peers: ReadonlySet<string>; startedAt: number; verifiedAt: number; expires: number } | undefined;
  private resolving: { startedAt: number; answer: Promise<ReadonlySet<string> | null> } | undefined;
  constructor(private readonly host: () => string, private readonly lookup: EmrPeerLookup) {}

  async current(): Promise<ReadonlySet<string>> {
    const now = Date.now(), cache = this.cache;
    if (cache && cache.expires > now) return cache.peers;
    const stale = cache && now - cache.verifiedAt < PEER_STALE_MS ? cache.peers : null;
    if (!this.resolving || now - this.resolving.startedAt > PEER_LOOKUP_ABANDON_MS) this.resolve(now);
    let timer: ReturnType<typeof setTimeout>;
    const waited = new Promise<null>(done => { timer = setTimeout(() => done(null), stale ? PEER_WAIT_MS : PEER_COLD_WAIT_MS); });
    try { return (await Promise.race([this.resolving.answer, waited])) ?? stale ?? new Set<string>(); }
    finally { clearTimeout(timer); }
  }

  private resolve(startedAt: number): void {
    let lookup: Promise<readonly { address: string }[]>;
    try { lookup = Promise.resolve(this.lookup(this.host())); }
    catch { lookup = Promise.resolve([]); }
    const answer = lookup.then(rows => {
      const peers = new Set((Array.isArray(rows) ? rows : []).map(row => row?.address)
        .filter(trustablePeer).map(address => String(address).replace(/^::ffff:/i, '')));
      if (!peers.size) return null;
      if (startedAt >= (this.cache?.startedAt ?? Number.NEGATIVE_INFINITY)) {
        const at = Date.now();
        this.cache = { peers, startedAt, verifiedAt: at, expires: at + PEER_FRESH_MS };
      }
      return peers;
    }, () => null);
    const resolving = { startedAt, answer };
    this.resolving = resolving;
    void answer.finally(() => { if (this.resolving === resolving) this.resolving = undefined; });
  }
}

interface Entry {
  readonly admission: Readonly<EmrVerifiedAdmission>;
  /** The transport as the request arrived: TCP peer and the X-Real-IP the proxy wrote, copied at capture. */
  readonly peer: string | null;
  readonly realIp: unknown;
  ended: boolean;
  facts?: Promise<Readonly<EmrAuthenticatedRequestFacts>>;
}

function admitted(admission: EmrVerifiedAdmission, issuer: string | undefined): Readonly<EmrVerifiedAdmission> {
  const text = (value: unknown) => typeof value === 'string' && value.trim() !== '' && !value.includes('\0');
  const a = admission ?? ({} as EmrVerifiedAdmission);
  if (!text(issuer) || a.issuer !== issuer) refuse('EmrRequestIssuerRefused');
  const roles = Array.isArray(a.roles) ? [...a.roles] : [];
  if (!text(a.subject) || !(a.displayName === null || typeof a.displayName === 'string') || !roles.length || !roles.every(text)
      || !text(a.institutionId) || !Number.isSafeInteger(a.rightsVersion) || a.rightsVersion < 0
      || !(a.authMethod === 'session' ? text(a.sessionRef) : a.authMethod === 'bearer' && a.sessionRef === null))
    refuse('EmrRequestAdmissionInvalid');
  return Object.freeze({ issuer: a.issuer, subject: a.subject, displayName: a.displayName, roles: Object.freeze(roles),
    institutionId: a.institutionId, rightsVersion: a.rightsVersion, authMethod: a.authMethod, sessionRef: a.sessionRef });
}

/**
 * The request source and its writer, created once per AuthService. The writer stays private to AuthService (its
 * captureEmrRequest, called by AuthGuard only); everyone else holds the read port.
 */
export function createEmrRequestContext(options: {
  runtime: Pick<EmrApplicationRuntime, 'requireResources' | 'trustedProxyHost'>;
  issuer: () => string | undefined;
  member: EmrMemberCheck;
  lookup: EmrPeerLookup;
}): { source: EmrAuthenticatedRequestSource; capture: EmrRequestCapture } {
  const entries = new WeakMap<object, Entry>();
  const peers = new TrustedProxyPeers(() => options.runtime.trustedProxyHost, options.lookup);
  const alive = (entry: Entry) => { if (entry.ended) refuse('EmrRequestEnded'); };

  async function identityOf(issuer: string, subject: string, displayName: string | null): Promise<ImmutableIdentity> {
    const { ledger } = options.runtime.requireResources();
    const known = await knownIdentity(verifiedIdentityClaims(issuer, subject, displayName),
      (iss, sub) => ledger.withAppendTransaction(tx => ledger.resolveIdentity(tx, iss, sub)));
    return known.value;
  }

  async function member(entry: Entry, subject: unknown): Promise<ImmutableIdentity> {
    alive(entry);
    if (typeof subject !== 'string' || subject.trim() === '' || subject.includes('\0')) refuse('EmrMemberRefused');
    await options.member(subject);
    const identity = await identityOf(entry.admission.issuer, subject, null);
    alive(entry);
    return identity;
  }

  async function materialize(entry: Entry): Promise<Readonly<EmrAuthenticatedRequestFacts>> {
    const a = entry.admission;
    const identity = await identityOf(a.issuer, a.subject, a.displayName);
    const trustedProxyIp = Object.freeze(ingressAddress(entry.peer, { 'x-real-ip': entry.realIp }, await peers.current()));
    const requestId = randomUUID();
    // A read that began before the response ended must not deliver after it.
    alive(entry);
    return Object.freeze({ identity, kind: 'member' as const, roles: a.roles, institutionId: a.institutionId,
      rightsVersion: a.rightsVersion, authMethod: a.authMethod, sessionRef: a.sessionRef, requestId, trustedProxyIp,
      member: (subject: string) => member(entry, subject) });
  }

  const source: EmrAuthenticatedRequestSource = Object.freeze({
    async facts(request: unknown): Promise<Readonly<EmrAuthenticatedRequestFacts>> {
      const entry = request !== null && typeof request === 'object' ? entries.get(request) : undefined;
      if (!entry) refuse('EmrRequestFactsRequired');
      alive(entry);
      // One materialization per request; a failed one stays failed for that request.
      return entry.facts ??= materialize(entry);
    },
  });

  /** Only an HTTP request with its response has a lifetime to bind; anything else (another transport) holds no facts. */
  function capture(request: unknown, response: unknown, admission: EmrVerifiedAdmission): void {
    if (!(request instanceof IncomingMessage) || !(response instanceof ServerResponse)) return;
    const earlier = entries.get(request);
    if (earlier) { earlier.ended = true; refuse('EmrRequestAlreadyCaptured'); }
    const entry: Entry = { admission: admitted(admission, options.issuer()), ended: false,
      peer: typeof request.socket?.remoteAddress === 'string' ? request.socket.remoteAddress : null,
      realIp: request.headers['x-real-ip'] };
    const end = () => { entry.ended = true; };
    // The response's end is the request's end; IncomingMessage's own 'close'/'end' only mean its body was read.
    response.once('finish', end);
    response.once('close', end);
    request.once('aborted', end);
    if (response.writableEnded || response.destroyed || request.aborted) end();
    entries.set(request, entry);
  }

  return { source, capture };
}
