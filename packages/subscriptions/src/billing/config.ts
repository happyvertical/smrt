/**
 * Host configuration surface for the billing glue (#4786).
 *
 * Environment variables, with the secrets held in non-enumerable properties so
 * a stray `JSON.stringify(config)` or `console.log(config)` cannot print them.
 * Error messages name the variable and never its value.
 */
import type { BillingUrls } from './types.js';

export const BILLING_ENV = {
  secretKey: 'STRIPE_SECRET_KEY',
  webhookSecret: 'STRIPE_WEBHOOK_SECRET',
  webhookTolerance: 'STRIPE_WEBHOOK_TOLERANCE',
  metadataSecret: 'BILLING_METADATA_SECRET',
  metadataPreviousSecrets: 'BILLING_METADATA_PREVIOUS_SECRETS',
  successUrl: 'BILLING_SUCCESS_URL',
  cancelUrl: 'BILLING_CANCEL_URL',
  portalReturnUrl: 'BILLING_PORTAL_RETURN_URL',
} as const;

export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300;
export const MAX_WEBHOOK_TOLERANCE_SECONDS = 900;

/** The env var holding the provider price id for a plan key. */
export function priceEnvName(planKey: string): string {
  return `STRIPE_PRICE_${planKey.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

export interface BillingEnvOptions {
  /** Plan keys whose `STRIPE_PRICE_<KEY>` variables should be read. */
  planKeys: readonly string[];
}

export interface BillingEnvConfig {
  /**
   * Provider credentials for `getAccountingProvider({ type: 'stripe', … })`.
   * `secretKey` and `webhookSecret` are non-enumerable (they do not survive
   * a spread, `JSON.stringify` or `console.log`), so read them by name.
   */
  stripe: {
    readonly secretKey: string;
    readonly webhookSecret: string;
    webhookTolerance: number;
  };
  /**
   * Checkout-metadata signing (#4786). `signingSecret` is unset unless
   * `BILLING_METADATA_SECRET` is configured (the host then falls back to the
   * webhook secret). `previousSecrets` (comma-separated
   * `BILLING_METADATA_PREVIOUS_SECRETS`) are still accepted when a completed
   * checkout is verified, so rotating a secret does not drop sessions created
   * before the rotation. Both are non-enumerable.
   */
  metadata: {
    readonly signingSecret: string | undefined;
    readonly previousSecrets: readonly string[];
  };
  urls: BillingUrls;
  /** Plan key to price id for every plan whose variable is set. */
  prices: Record<string, string>;
}

type Env = Record<string, string | undefined>;

function read(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function required(env: Env, name: string): string {
  const value = read(env, name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

/**
 * Validate a redirect destination: absolute, no embedded credentials, and
 * https (plain http only for loopback development hosts).
 */
export function assertBillingUrl(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL.`);
  }
  const loopback =
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]' ||
    url.hostname.endsWith('.localhost');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`${name} must use https.`);
  }
  if (url.username || url.password) {
    throw new Error(`${name} must not contain credentials.`);
  }
  // Returned as given: Checkout expands a literal `{CHECKOUT_SESSION_ID}`
  // placeholder that URL normalisation would percent-encode.
  return value;
}

export function assertWebhookTolerance(seconds: number): number {
  if (
    !Number.isInteger(seconds) ||
    seconds < 1 ||
    seconds > MAX_WEBHOOK_TOLERANCE_SECONDS
  ) {
    throw new Error(
      `The webhook tolerance must be a whole number of seconds from 1 to ${MAX_WEBHOOK_TOLERANCE_SECONDS}.`,
    );
  }
  return seconds;
}

/** Read and validate billing configuration from an environment map. */
export function readBillingEnv(
  env: Env,
  options: BillingEnvOptions,
): BillingEnvConfig {
  const secretKey = required(env, BILLING_ENV.secretKey);
  if (!/^(sk|rk)_/.test(secretKey)) {
    throw new Error(
      `${BILLING_ENV.secretKey} must be a secret key (sk_ or rk_).`,
    );
  }
  const webhookSecret = required(env, BILLING_ENV.webhookSecret);
  if (!webhookSecret.startsWith('whsec_')) {
    throw new Error(
      `${BILLING_ENV.webhookSecret} must be a webhook signing secret (whsec_).`,
    );
  }
  const toleranceText = read(env, BILLING_ENV.webhookTolerance);
  const tolerance = toleranceText
    ? Number(toleranceText)
    : DEFAULT_WEBHOOK_TOLERANCE_SECONDS;
  try {
    assertWebhookTolerance(tolerance);
  } catch {
    throw new Error(
      `${BILLING_ENV.webhookTolerance} must be a whole number of seconds from 1 to ${MAX_WEBHOOK_TOLERANCE_SECONDS}.`,
    );
  }

  const prices: Record<string, string> = {};
  for (const planKey of options.planKeys) {
    const price = read(env, priceEnvName(planKey));
    if (price) prices[planKey] = price;
  }

  const stripe = { webhookTolerance: tolerance } as BillingEnvConfig['stripe'];
  Object.defineProperty(stripe, 'secretKey', {
    value: secretKey,
    enumerable: false,
  });
  Object.defineProperty(stripe, 'webhookSecret', {
    value: webhookSecret,
    enumerable: false,
  });

  const metadata = {} as BillingEnvConfig['metadata'];
  Object.defineProperty(metadata, 'signingSecret', {
    value: read(env, BILLING_ENV.metadataSecret),
    enumerable: false,
  });
  Object.defineProperty(metadata, 'previousSecrets', {
    value: (read(env, BILLING_ENV.metadataPreviousSecrets) ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
    enumerable: false,
  });

  return {
    stripe,
    metadata,
    prices,
    urls: {
      successUrl: assertBillingUrl(
        BILLING_ENV.successUrl,
        required(env, BILLING_ENV.successUrl),
      ),
      cancelUrl: assertBillingUrl(
        BILLING_ENV.cancelUrl,
        required(env, BILLING_ENV.cancelUrl),
      ),
      portalReturnUrl: assertBillingUrl(
        BILLING_ENV.portalReturnUrl,
        required(env, BILLING_ENV.portalReturnUrl),
      ),
    },
  };
}
