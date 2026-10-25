import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ImmutableIdentity } from '../emr-contract/access-event';
import { knownIdentity, verifiedIdentityClaims } from './contract';
import type { EmrRecordPort, EmrRecordWork, EmrRecordTransaction } from './record-port';
import { observeRequestIngress } from './request-ingress';
import type { RequestIngress, RequestIngressFact, RequestIngressObservation } from './request-ingress';

export const REQUEST_CONTEXT_CAPTURE = Symbol('RequestContextCapture');
export const REQUEST_CONTEXT_SOURCE = Symbol('RequestContextSource');
export type RequestSessionBinding = Readonly<
  { method: 'session'; sessionRef: string } | { method: 'bearer'; sessionRef: null }
>;
export interface VerifiedMemberAdmission {
  readonly issuer: string;
  readonly subject: string;
  readonly roles: readonly string[];
  readonly institution: string;
  readonly rightsVersion: number;
  readonly binding: RequestSessionBinding;
}
export interface RequestRouteContext {
  readonly method: string;
  readonly route: string;
  readonly purpose: 'clinical' | 'authentication';
}
export interface CapturedRequestAdmission extends VerifiedMemberAdmission {
  readonly requestId: string;
  readonly route: Readonly<RequestRouteContext>;
}
export interface RequestFacts extends CapturedRequestAdmission {
  readonly actor: Readonly<ImmutableIdentity>;
  readonly ingress: RequestIngressFact;
  readonly surface: string;
}
export type CurrentRequestAuthorization = (tx?: EmrRecordTransaction) => Promise<void>;
export interface RequestWorkContext {
  readonly facts: RequestFacts;
  readonly work: EmrRecordWork;
  assertActive(): void;
  requireCurrent(tx?: EmrRecordTransaction): Promise<void>;
}
export interface RequestContextSource {
  read(request: IncomingMessage): CapturedRequestAdmission;
  ingress(request: IncomingMessage): Promise<RequestIngressFact>;
  facts(request: IncomingMessage): Promise<RequestFacts>;
  /** The callback owns all its follow-ups, including settlement after disconnect.
   * It may retain this work to settle. Writes that re-check authorization call requireCurrent;
   * reads do not (W9API-20 disposed, D1764).
   */
  withWork<T>(request: IncomingMessage, task: (context: RequestWorkContext) => Promise<T>): Promise<T>;
}
export interface RequestContextCapture {
  capture(request: IncomingMessage, response: ServerResponse, verified: VerifiedMemberAdmission,
    route: RequestRouteContext, current: CurrentRequestAuthorization): void;
}
export class RequestContextUnavailable extends Error {
  constructor() { super('Request context is not active'); this.name = 'RequestContextUnavailable'; }
}
interface AdmissionEntry {
  readonly snapshot: CapturedRequestAdmission;
  readonly observation: RequestIngressObservation;
  readonly current: CurrentRequestAuthorization;
  readonly ended: () => boolean;
  active: boolean;
  owners: number;
  work?: EmrRecordWork;
  materialization?: Promise<RequestFacts>;
  ingress?: Promise<RequestIngressFact>;
}

/** One final Guard capture per HTTP request. No identity/DNS/ledger work occurs
 * until a consumer asks. The ledger's existing work owns operation drainage.
 */
export function createRequestContext(ingress: RequestIngress, port: EmrRecordPort): {
  capture: RequestContextCapture; source: RequestContextSource;
} {
  const requests = new WeakMap<IncomingMessage, AdmissionEntry>();
  const assertActive = (entry: AdmissionEntry) => {
    if (entry.ended()) { entry.active = false; release(entry); }
    if (!entry.active) throw new RequestContextUnavailable();
  };
  const requireActive = (request: IncomingMessage): AdmissionEntry => {
    const entry = requests.get(request);
    if (!entry) throw new RequestContextUnavailable();
    assertActive(entry);
    return entry;
  };
  const release = (entry: AdmissionEntry) => {
    if (!entry.active && entry.owners === 0 && entry.work) {
      entry.work.end();
      entry.work = undefined;
    }
  };
  const resolveIngress = (entry: AdmissionEntry) => {
    if (!entry.ingress) entry.ingress = Promise.resolve().then(() => {
      assertActive(entry);
      return ingress.resolve(entry.observation);
    }).then(value => { assertActive(entry); return value; });
    return entry.ingress;
  };
  const materialize = (entry: AdmissionEntry): Promise<RequestFacts> => {
    if (!entry.materialization) {
      entry.owners++;
      entry.materialization = Promise.resolve().then(async () => {
        assertActive(entry);
        const observed = await resolveIngress(entry);
        assertActive(entry);
        const work = entry.work = port.begin();
        const identity = await knownIdentity(verifiedIdentityClaims(entry.snapshot.issuer, entry.snapshot.subject, null),
          (issuer, subject) => work.resolveRequestIdentity(issuer, subject));
        assertActive(entry);
        return Object.freeze({ ...entry.snapshot, actor: Object.freeze({ ...identity.value }), ingress: observed,
          surface: entry.snapshot.route.method + ' ' + entry.snapshot.route.route });
      }).catch(error => {
        // A failed materialization is final for this request, including its handle.
        entry.work?.end();
        entry.work = undefined;
        throw error;
      }).finally(() => { entry.owners--; release(entry); });
    }
    return entry.materialization;
  };
  const capture = Object.freeze<RequestContextCapture>({
    capture(request, response, verified, route, current) {
      // A repeated capture cannot replace attribution or revive a closed request.
      if (requests.has(request)) return;
      const snapshot: CapturedRequestAdmission = Object.freeze({
        issuer: verified.issuer, subject: verified.subject,
        roles: Object.freeze([...verified.roles]), institution: verified.institution,
        rightsVersion: verified.rightsVersion,
        binding: verified.binding.method === 'session'
          ? Object.freeze({ method: 'session', sessionRef: verified.binding.sessionRef })
          : Object.freeze({ method: 'bearer', sessionRef: null }),
        requestId: randomUUID(),
        route: Object.freeze({ method: route.method, route: route.route, purpose: route.purpose }),
      });
      const ended = () => request.aborted || response.destroyed || response.writableEnded || response.writableFinished;
      const entry: AdmissionEntry = { snapshot, observation: observeRequestIngress(request), current, ended,
        owners: 0, active: !ended() };
      requests.set(request, entry);
      if (!entry.active) return;
      const revoke = () => {
        entry.active = false;
        release(entry);
        response.off('finish', revoke);
        response.off('close', revoke);
        response.off('error', revoke);
        request.off('aborted', revoke);
        request.off('error', revoke);
      };
      // Middleware may have registered a completion observer before the Guard.
      // It must see a revoked source, never start work from that callback.
      response.prependOnceListener('finish', revoke);
      response.prependOnceListener('close', revoke);
      response.prependOnceListener('error', revoke);
      request.prependOnceListener('aborted', revoke);
      request.prependOnceListener('error', revoke);
      // Request end/ordinary close only ends receipt of the request body.
    },
  });
  const source = Object.freeze<RequestContextSource>({
    read(request) { return requireActive(request).snapshot; },
    ingress(request) {
      try { return resolveIngress(requireActive(request)); }
      catch (error) { return Promise.reject(error); }
    },
    facts(request) {
      try { return materialize(requireActive(request)); }
      catch (error) { return Promise.reject(error); }
    },
    async withWork<T>(request: IncomingMessage, task: (context: RequestWorkContext) => Promise<T>): Promise<T> {
      const entry = requireActive(request);
      entry.owners++;
      try {
        const facts = await materialize(entry);
        assertActive(entry);
        const result = await task(Object.freeze({ facts, work: entry.work,
          assertActive: () => assertActive(entry),
          async requireCurrent(tx?: EmrRecordTransaction) {
            assertActive(entry);
            await entry.current(tx);
            assertActive(entry);
          },
        }));
        assertActive(entry);
        return result;
      } finally { entry.owners--; release(entry); }
    },
  });
  return { capture, source };
}
