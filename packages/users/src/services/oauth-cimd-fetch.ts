/**
 * SSRF-guarded HTTPS fetch for OAuth Client ID Metadata Documents (#5081).
 *
 * The client_id URL is attacker-chosen, so this is the trust boundary: refuse
 * private, loopback, link-local, CGNAT, metadata and other non-public
 * addresses; resolve DNS once and pin the connection to the vetted address
 * (no second lookup, so DNS rebinding cannot swap it); never follow redirects;
 * cap time and bytes; send no credentials.
 *
 * `@happyvertical/smrt-content` has an equivalent guard (`safe-remote-url`),
 * but users cannot depend on content (content depends on a large part of the
 * workspace and lists users as a dev dependency), so the narrow subset needed
 * here lives in this file, built on `node:net` BlockList.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';

/** A fully buffered, bounded response. Header names are lower-case. */
export interface CimdFetchResult {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: string;
}
/** Fetches one already syntax-validated client_id URL. Injectable for tests. */
export type CimdFetcher = (
  url: URL,
  limits: { timeoutMs: number; maxBytes: number },
) => Promise<CimdFetchResult>;
export type ResolveHostname = (
  hostname: string,
) => Promise<{ address: string; family?: number }[]>;

const blockedV4 = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const)
  blockedV4.addSubnet(net, prefix, 'ipv4');
// IPv6: only global unicast (2000::/3) is allowed, minus special-purpose
// ranges. Loopback, ULA, link-local, multicast, IPv4-mapped and NAT64 all sit
// outside 2000::/3 and are therefore refused.
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const blockedV6 = new BlockList();
for (const [net, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const)
  blockedV6.addSubnet(net, prefix, 'ipv6');

/** True for anything that is not a plain public unicast address. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blockedV4.check(address, 'ipv4');
  if (family === 6)
    return !globalV6.check(address, 'ipv6') || blockedV6.check(address, 'ipv6');
  return true;
}

const defaultResolve: ResolveHostname = (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

/** Resolve once and refuse unless EVERY returned address is public. */
async function resolvePublic(
  hostname: string,
  resolve: ResolveHostname,
): Promise<{ address: string; family: 4 | 6 }> {
  const addresses = await resolve(hostname);
  if (!addresses.length || addresses.some((a) => isBlockedAddress(a.address)))
    throw new Error('client_id host does not resolve to a public address');
  const first = addresses[0].address;
  return { address: first, family: isIP(first) === 6 ? 6 : 4 };
}

/** Default fetcher: DNS-pinned node:https, no redirects, bounded time and bytes. */
export function createSafeCimdFetcher(
  options: { resolveHostname?: ResolveHostname } = {},
): CimdFetcher {
  const resolve = options.resolveHostname ?? defaultResolve;
  return async (url, { timeoutMs, maxBytes }) => {
    if (url.protocol !== 'https:') throw new Error('client_id must be https');
    const pinned = await resolvePublic(url.hostname, resolve);
    return new Promise<CimdFetchResult>((resolvePromise, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const req = request(
        url,
        {
          method: 'GET',
          // Vetted address only; the hostname is never resolved again.
          lookup: (_host, lookupOptions, callback) => {
            if (lookupOptions.all) callback(null, [pinned]);
            else callback(null, pinned.address, pinned.family);
          },
          headers: {
            accept: 'application/json',
            'accept-encoding': 'identity',
            'user-agent': 'smrt-users-oauth-cimd',
          },
        },
        (res) => {
          const declared = Number(res.headers['content-length']);
          if (Number.isFinite(declared) && declared > maxBytes) {
            req.destroy();
            finish(() => reject(new Error('client metadata exceeds size cap')));
            return;
          }
          const chunks: Buffer[] = [];
          let total = 0;
          res.on('data', (chunk: Buffer) => {
            total += chunk.byteLength;
            if (total > maxBytes) {
              req.destroy();
              finish(() =>
                reject(new Error('client metadata exceeds size cap')),
              );
              return;
            }
            chunks.push(chunk);
          });
          res.on('error', (error) => finish(() => reject(error)));
          res.on('end', () =>
            finish(() => {
              const headers: Record<string, string> = {};
              for (const [name, value] of Object.entries(res.headers))
                if (value !== undefined)
                  headers[name.toLowerCase()] = Array.isArray(value)
                    ? value.join(', ')
                    : value;
              try {
                resolvePromise({
                  status: res.statusCode ?? 0,
                  headers,
                  body: new TextDecoder('utf-8', { fatal: true }).decode(
                    Buffer.concat(chunks),
                  ),
                });
              } catch (error) {
                reject(error);
              }
            }),
          );
        },
      );
      const timer = setTimeout(() => {
        req.destroy();
        finish(() => reject(new Error('client metadata fetch timed out')));
      }, timeoutMs);
      req.on('error', (error) => finish(() => reject(error)));
      req.end();
    });
  };
}
