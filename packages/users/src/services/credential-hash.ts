/**
 * scrypt hashing shared by the PIN (#3276) and password (#3274) credentials.
 *
 * The encoded form is self-describing — `scrypt$N$r$p$saltB64$hashB64` — so
 * every stored hash carries the parameters it was derived with. Raising the
 * policy therefore never breaks an existing hash: it still verifies with its
 * own parameters and is rehashed under the new ones on the next successful
 * sign-in ({@link scryptHashNeedsUpgrade}).
 *
 * The secret is hashed as `pepper || 0x00 || secret`; an empty pepper is
 * allowed. Comparison uses `timingSafeEqual`.
 *
 * Internal module: not exported from the package index.
 *
 * @packageDocumentation
 */

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/** scrypt cost parameters. */
export interface ScryptParams {
  /** CPU/memory cost; a power of two. */
  N: number;
  /** Block size. */
  r: number;
  /** Parallelisation. */
  p: number;
}

/** Derived key length in bytes. */
export const SCRYPT_HASH_BYTES = 32;
/** Random salt length in bytes, fresh for every hash. */
export const SCRYPT_SALT_BYTES = 16;

/**
 * Ceilings on parameters read back from storage or configuration. A stored
 * row is server-written, but a corrupt or tampered one must not be able to
 * make a single verify allocate gigabytes.
 */
const MAX_N = 2 ** 20;
const MAX_R = 32;
const MAX_P = 16;

/** True when `params` are structurally valid scrypt parameters within the ceilings. */
export function isValidScryptParams(params: ScryptParams): boolean {
  const { N, r, p } = params;
  return (
    Number.isSafeInteger(N) &&
    Number.isSafeInteger(r) &&
    Number.isSafeInteger(p) &&
    N >= 2 &&
    N <= MAX_N &&
    (N & (N - 1)) === 0 &&
    r >= 1 &&
    r <= MAX_R &&
    p >= 1 &&
    p <= MAX_P
  );
}

function derive(
  secret: string,
  pepper: string,
  params: ScryptParams,
  salt: Buffer,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(
      `${pepper}\u0000${secret}`,
      salt,
      SCRYPT_HASH_BYTES,
      {
        N: params.N,
        r: params.r,
        p: params.p,
        // Node's default maxmem (32 MiB) is below scrypt's 128·r·(N + p + 2)
        // bytes for the default parameters; allow headroom so the derivation
        // never throws.
        maxmem: 128 * params.r * (params.N + params.p + 2) * 2,
      },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

/** Hash `secret` with a fresh random salt (or `salt`, for verification). */
export async function hashSecret(
  secret: string,
  pepper: string,
  params: ScryptParams,
  salt: Buffer = randomBytes(SCRYPT_SALT_BYTES),
): Promise<string> {
  const derived = await derive(secret, pepper, params, salt);
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

interface ParsedScryptHash {
  params: ScryptParams;
  salt: Buffer;
  hash: Buffer;
}

/** Parse an encoded hash; null for anything malformed or out of bounds. */
export function parseScryptHash(encoded: string): ParsedScryptHash | null {
  if (typeof encoded !== 'string') return null;
  const [scheme, N, r, p, saltB64, hashB64, ...rest] = encoded.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64 || rest.length > 0) {
    return null;
  }
  const params = { N: Number(N), r: Number(r), p: Number(p) };
  if (!isValidScryptParams(params)) return null;
  const hash = Buffer.from(hashB64, 'base64');
  if (hash.length !== SCRYPT_HASH_BYTES) return null;
  return { params, salt: Buffer.from(saltB64, 'base64'), hash };
}

/**
 * Verify `secret` against an encoded hash in constant time. A malformed
 * encoding verifies false.
 */
export async function verifySecretHash(
  secret: string,
  pepper: string,
  encoded: string,
): Promise<boolean> {
  const parsed = parseScryptHash(encoded);
  if (!parsed) return false;
  const candidate = await derive(secret, pepper, parsed.params, parsed.salt);
  return (
    candidate.length === parsed.hash.length &&
    timingSafeEqual(candidate, parsed.hash)
  );
}

/**
 * The scrypt derivations whose work makes up the difference between
 * verifying `encoded` and verifying a hash under `policy` — empty when there
 * is no meaningful difference. A malformed encoding verifies without
 * deriving, so it owes the policy's whole cost.
 *
 * Every derivation keeps the policy's memory shape, so padding never touches
 * more memory than one current-policy verification: whole lanes are spent as
 * one derivation at the policy's own `N` and `r` with `p` lanes (`p` never
 * exceeds the policy's), and the remainder as up to six single-lane
 * derivations at the policy's `r` with halving powers of two for `N`. The
 * total matches the policy's cost to within 1/64 of a lane.
 */
export function scryptPaddingParams(
  encoded: string,
  policy: ScryptParams,
): ScryptParams[] {
  const parsed = parseScryptHash(encoded);
  const total = scryptCost(policy);
  let deficit = total - (parsed ? scryptCost(parsed.params) : 0);
  const padding: ScryptParams[] = [];
  const lane = policy.N * policy.r;
  const lanes = Math.floor(deficit / lane);
  if (lanes >= 1) {
    padding.push({ N: policy.N, r: policy.r, p: lanes });
    deficit -= lanes * lane;
  }
  for (let step = 0; step < 6 && deficit >= lane / 64; step++) {
    const N = 2 ** Math.floor(Math.log2(deficit / policy.r));
    if (N < 2) break;
    padding.push({ N, r: policy.r, p: 1 });
    deficit -= N * policy.r;
  }
  return padding;
}

/**
 * After verifying against `encoded`, spend the work verifying under
 * `policy` would have cost beyond it ({@link scryptPaddingParams}), so a hash
 * still carrying weaker parameters costs about what a current-policy hash —
 * such as the dummy hash a missing credential is compared against — does.
 */
export async function padScryptWork(
  encoded: string,
  policy: ScryptParams,
): Promise<void> {
  for (const params of scryptPaddingParams(encoded, policy)) {
    await derive('', '', params, randomBytes(SCRYPT_SALT_BYTES));
  }
}

/** Relative scrypt work: ROMix runs `2·N` BlockMix rounds of cost `r`, `p` times. */
export function scryptCost(params: ScryptParams): number {
  return params.N * params.r * params.p;
}

/**
 * True when the stored hash was derived with weaker parameters than
 * `policy` on any axis (or cannot be parsed), so it should be rehashed after
 * the next successful verification.
 */
export function scryptHashNeedsUpgrade(
  encoded: string,
  policy: ScryptParams,
): boolean {
  const parsed = parseScryptHash(encoded);
  if (!parsed) return true;
  return (
    parsed.params.N < policy.N ||
    parsed.params.r < policy.r ||
    parsed.params.p < policy.p
  );
}
