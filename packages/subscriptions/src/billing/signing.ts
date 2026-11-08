/**
 * Signed Checkout metadata and secret hygiene (#4786).
 *
 * Another integration on the same Stripe account can create Checkout Sessions
 * with any metadata it likes. A completed session is only trusted to link a
 * tenant and plan when its `smrt_*` metadata carries an HMAC made with a
 * server-side secret at session creation. Uses WebCrypto so the module loads
 * in every runtime the package does.
 */

export const METADATA_SIGNATURE_KEY = 'smrt_sig';
export const METADATA_PURPOSE = 'tenant_subscription';

const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toHex(
    new Uint8Array(
      await crypto.subtle.sign('HMAC', key, encoder.encode(message)),
    ),
  );
}

/** Compare without an early exit on the first differing character. */
export function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

function canonical(metadata: Record<string, string>): string {
  return JSON.stringify(
    Object.entries(metadata)
      .filter(
        ([key, value]) =>
          key.startsWith('smrt_') &&
          key !== METADATA_SIGNATURE_KEY &&
          value !== '',
      )
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/** Add the signature to `metadata`. Only `smrt_*` keys are covered. */
export async function signCheckoutMetadata(
  metadata: Record<string, string>,
  secret: string,
): Promise<Record<string, string>> {
  return {
    ...metadata,
    [METADATA_SIGNATURE_KEY]: await hmacHex(
      `smrt-subscription-checkout:${secret}`,
      canonical(metadata),
    ),
  };
}

export async function checkoutMetadataValid(
  metadata: Record<string, string>,
  secret: string,
): Promise<boolean> {
  const given = metadata[METADATA_SIGNATURE_KEY];
  if (!given) return false;
  return constantTimeEqual(
    given,
    await hmacHex(`smrt-subscription-checkout:${secret}`, canonical(metadata)),
  );
}

const SECRET_PATTERN = /\b(?:sk|rk|pk|whsec)_[A-Za-z0-9_]{4,}/g;

/**
 * Strip anything shaped like a Stripe key or signing secret. Applied to every
 * error message before it reaches a log, as provider errors can echo the
 * credential they were called with.
 */
export function redactSecrets(text: string): string {
  return text.replace(SECRET_PATTERN, '[redacted]');
}

export function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message).slice(0, 300);
}
