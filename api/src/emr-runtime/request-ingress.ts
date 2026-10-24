import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import type { EvidenceFact } from '../emr-contract/access-event';

export type RequestIngressFact = EvidenceFact<Readonly<{ address: string; source: 'trusted-proxy' }>>;
export interface RequestIngressObservation {
  readonly peer: string | null;
  readonly address: string | null;
}
export interface RequestIngressConfiguration { readonly proxyPeers: readonly string[] }
export interface RequestIngress {
  resolve(observation: RequestIngressObservation): Promise<RequestIngressFact>;
}
type PeerLookup = (hostname: string) => Promise<readonly LookupAddress[]>;

const notObserved: RequestIngressFact = Object.freeze({ status: 'unresolved', reason: 'not-observed' });

/** Socket IPv4-mapped addresses and deployment IPv4 literals name the same peer. */
function comparableIp(address: string): string | null {
  if (isIP(address) === 4) return address;
  if (isIP(address) !== 6) return null;
  try {
    const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
    if (!canonical.startsWith('::ffff:')) return canonical;
    const words = canonical.slice(7).split(':');
    if (words.length !== 2) return canonical;
    const high = parseInt(words[0], 16), low = parseInt(words[1], 16);
    return [high >> 8, high & 255, low >> 8, low & 255].join('.');
  } catch { return null; }
}

/** Copy the real transport boundary before another handler decorates the request. */
export function observeRequestIngress(request: Pick<IncomingMessage, 'socket' | 'rawHeaders'>): RequestIngressObservation {
  const peer = request.socket.remoteAddress ?? null;
  const values: string[] = [];
  const headers = request.rawHeaders;
  if (headers.length % 2 === 0) {
    for (let index = 0; index < headers.length; index += 2) {
      if (headers[index].toLowerCase() === 'x-real-ip') values.push(headers[index + 1].trim());
    }
  }
  const address = values.length === 1 && comparableIp(values[0]) !== null ? values[0] : null;
  return Object.freeze({ peer, address });
}

/** Use deployment peers, with normal OS resolution on each consumed request.
 * No private DNS cache/TTL: a replacement proxy must not retain its old address.
 * Lookup failure propagates; it is not evidence of an observed client address.
 */
export function createRequestIngress(configuration: RequestIngressConfiguration,
  resolvePeer: PeerLookup = hostname => lookup(hostname, { all: true })): RequestIngress {
  const peers = [...configuration.proxyPeers];
  if (peers.some(peer => !peer.trim())) throw new Error('Deployment proxy peer is empty');
  return Object.freeze({
    async resolve(observation: RequestIngressObservation): Promise<RequestIngressFact> {
      const peer = observation.peer === null ? null : comparableIp(observation.peer);
      if (peer === null || observation.address === null || comparableIp(observation.address) === null) return notObserved;
      const addresses = await Promise.all(peers.map(async configured => {
        const literal = comparableIp(configured);
        return literal === null
          ? (await resolvePeer(configured)).map(result => comparableIp(result.address))
          : [literal];
      }));
      if (!addresses.some(group => group.includes(peer))) return notObserved;
      return Object.freeze({ status: 'known', value: Object.freeze({ address: observation.address, source: 'trusted-proxy' }) });
    },
  });
}
