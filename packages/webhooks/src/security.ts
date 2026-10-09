import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';

/** Conservative public-unicast allowlist. Transition/mapped IPv6 is excluded. */
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(address) !== 6) return false;
  const normalized = new URL(`https://[${address}]/`).hostname.slice(1, -1);
  // Only global unicast 2000::/3; exclude IETF special-purpose, documentation,
  // 6to4, and the newer documentation block (3fff::/20).
  const first = Number.parseInt(normalized.split(':')[0], 16);
  return (
    first >= 0x2000 &&
    first < 0x4000 &&
    first !== 0x2002 &&
    !(
      first === 0x2001 &&
      Number.parseInt(normalized.split(':')[1] || '0', 16) < 0x200
    ) &&
    !normalized.startsWith('2001:db8:') &&
    first !== 0x3fff
  );
}

export function assertWebhookUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Webhook URL must be an absolute HTTPS URL.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== '443') ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    (isIP(host) && !isPublicAddress(host))
  ) {
    throw new Error(
      'Webhook URL must use public HTTPS on port 443 without credentials or a fragment.',
    );
  }
  return url;
}

export function assertHmacSecret(secret: string): void {
  if (
    typeof secret !== 'string' ||
    Buffer.byteLength(secret) < 32 ||
    Buffer.byteLength(secret) > 4096
  ) {
    throw new Error('Webhook signing secret must contain 32 to 4096 bytes.');
  }
}

export interface WebhookRequest {
  url: string;
  body: string;
  headers: Record<string, string>;
}
export type WebhookTransport = (request: WebhookRequest) => Promise<number>;

/** Validate every DNS answer, then pin the socket lookup; TLS still verifies the hostname.
 * No proxy, redirects, pooled sockets, response body buffering, or second DNS lookup.
 */
export const sendPublicWebhook: WebhookTransport = async ({
  url,
  body,
  headers,
}) => {
  const target = assertWebhookUrl(url);
  const host = target.hostname.replace(/^\[|\]$/g, '');
  let dnsTimer: ReturnType<typeof setTimeout> | undefined;
  const answers = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await Promise.race([
        lookup(host, { all: true, verbatim: true }),
        new Promise<never>((_, reject) => {
          dnsTimer = setTimeout(
            () => reject(new Error('Webhook DNS timeout.')),
            5000,
          );
          dnsTimer.unref();
        }),
      ]).finally(() => clearTimeout(dnsTimer));
  if (
    !answers.length ||
    answers.some(({ address }) => !isPublicAddress(address))
  ) {
    throw new Error('Webhook destination is not public.');
  }
  const pinned = answers[0];
  return new Promise<number>((resolve, reject) => {
    const req = request(
      target,
      {
        method: 'POST',
        agent: false,
        headers: {
          ...headers,
          'content-length': Buffer.byteLength(body).toString(),
        },
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [pinned]);
          else callback(null, pinned.address, pinned.family);
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        response.destroy();
        resolve(status);
      },
    );
    const timer = setTimeout(
      () => req.destroy(new Error('Webhook request timeout.')),
      10000,
    );
    req.on('close', () => clearTimeout(timer));
    req.on('error', () => reject(new Error('Webhook transport failed.')));
    req.end(body);
  });
};
