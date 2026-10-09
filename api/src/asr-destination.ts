import { BlockList, isIP } from 'node:net';
import * as dns from 'node:dns';
import * as http from 'node:http';
import * as https from 'node:https';
import { Readable } from 'node:stream';

// Only deployment-local unicast ranges: RFC1918, loopback, link-local and IPv6 ULA.
// BlockList also classifies IPv4-mapped IPv6 using the embedded IPv4 address.
const internal = new BlockList();
for (const [address, prefix] of [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16],
  ['127.0.0.0', 8], ['169.254.0.0', 16]] as const) internal.addSubnet(address, prefix);
internal.addAddress('::1', 'ipv6');
internal.addSubnet('fc00::', 7, 'ipv6');
internal.addSubnet('fe80::', 10, 'ipv6');

export function isInternalAsrAddress(address: string) {
  const family = isIP(address);
  return !!family && internal.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export function asrDestination(raw: string | undefined): URL | null {
  if (!raw || !/^https?:\/\//.test(raw) || /[\s\\?#]/.test(raw)) return null;
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (url.username || url.password || url.pathname !== '/inference' || url.port === '0') return null;
    // A single DNS label is a compose-local candidate, never a suffix-based trust rule.
    // Its actual addresses are checked by the socket's lookup below, with no second lookup.
    if (isIP(host) ? !isInternalAsrAddress(host) : !/^[a-z][a-z0-9_-]{0,62}$/.test(host)) return null;
    return url;
  } catch { return null; }
}

export class AsrDestinationError extends Error {
  constructor() { super('ASR destination must resolve exclusively to internal network addresses'); }
}

// Native HTTP(S) gives us a per-socket lookup without an extra dependency or a
// DNS check/use gap. TLS still verifies the configured hostname; no redirects/proxies.
export async function asrFetch(url: string, options: RequestInit): Promise<Response> {
  const target = asrDestination(url);
  if (!target) throw new AsrDestinationError();
  const serialized = new Request(target, options);
  const body = Buffer.from(await serialized.arrayBuffer());
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const send = target.protocol === 'https:' ? https.request : http.request;
    const request = send(target, {
      method: 'POST', agent: false, signal: options.signal,
      headers: { 'content-type': serialized.headers.get('content-type'), 'content-length': body.length },
      lookup: (host, opts, callback) => {
        dns.lookup(host, { all: true, verbatim: true }, (error, addresses) => {
          if (error || !addresses?.length || addresses.some(item => !isInternalAsrAddress(item.address))) {
            callback(new AsrDestinationError(), undefined, undefined);
            return;
          }
          // Return only the checked results directly to this socket, including
          // the all-addresses mode used by Node's IPv4/IPv6 selection.
          if (opts.all) callback(null, addresses);
          else callback(null, addresses[0].address, addresses[0].family);
        });
      },
    }, response => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.destroy();
        reject(new Error('ASR upstream refused'));
        return;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      resolve(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, { headers }));
    });
    request.on('error', reject);
    request.end(body);
  });
}
