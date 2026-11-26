// The link token that lets the CLI present a desktop app to the hosted
// receiver without the owner's browser session (#5638, #5193). A new trust
// path, so it is as narrow as it can be:
//
// - Minted only by the verified owner (`assertOwner`), hosted profile only.
// - One tenant (the minter's, written into the token and the row) and one
//   action (`app.receive`). The only code that accepts it is the receive
//   route; every other route reads the owner session and ignores it.
// - Short-lived: ten minutes by default, fifteen at most, fixed at minting.
// - Single use: the first presentation that passes every check spends it with
//   one conditional UPDATE, before the bundle is touched. A failed receive
//   needs a new token (the receive itself converges on a rerun).
// - Only the SHA-256 of the 256-bit secret is stored; the token is returned
//   once and is never logged, put in a URL or written to a field the shell
//   reads back. Minting revokes every earlier unspent token of the tenant.
// - The secret is compared in constant time; every refusal is the same 401,
//   so the response does not say which check failed.
// - The receive runs as the owner who minted it, and only while that person
//   still holds the owner role (looked up on every redemption).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { EngineError } from '../../engine/index.ts';
import { ReceiveLinkCollection } from '../objects/ReceiveLink.ts';
import { getShellDb, requireCloudProfile, safeId } from './host.ts';
import {
  assertOwner,
  PolicyError,
  type Principal,
  requireOwner,
  runAs,
} from './owner.ts';

export const RECEIVE_SCOPE = 'app.receive';
export const RECEIVE_LINK_DEFAULT_TTL_SECONDS = 10 * 60;
export const RECEIVE_LINK_MAX_TTL_SECONDS = 15 * 60;
const TOKEN_PREFIX = 'smrt-rl1';
const TOKEN =
  /^smrt-rl1\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/i;
/** Names the lookup scope only; never a principal (the real one comes from the row). */
const LOOKUP_USER = 'receive-link-lookup';
const INVALID = 'the link token is not valid';

export interface MintedReceiveLink {
  /** The bearer token: shown once, never stored. */
  token: string;
  expiresAt: string;
  scope: typeof RECEIVE_SCOPE;
}

/** A token that passed every check but has not been spent yet. */
export interface VerifiedReceiveLink {
  id: string;
  tenantId: string;
  ownerId: string;
  /** Hex hash of the presented secret: the spend only takes the row still holding it. */
  tokenHash: string;
}

/** The tenant's one row id: a UUID derived from the tenant, so a second insert is a key clash. */
function slotId(tenantId: string): string {
  const h = createHash('sha256')
    .update(`smrt-receive-link:${tenantId}`)
    .digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const hashOf = (secret: string): Buffer =>
  createHash('sha256').update(secret, 'utf8').digest();

/** Mint a token as the verified owner of the running scope. */
export async function mintReceiveLink(
  ttlSeconds: number = RECEIVE_LINK_DEFAULT_TTL_SECONDS,
  now: () => number = Date.now,
): Promise<MintedReceiveLink> {
  await requireCloudProfile('Receiving a user app');
  const owner = await assertOwner();
  // Only shorter than the default may be asked for; never longer than the cap.
  if (
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < 1 ||
    ttlSeconds > RECEIVE_LINK_MAX_TTL_SECONDS
  )
    throw new EngineError(
      `ttlSeconds must be a whole number from 1 to ${RECEIVE_LINK_MAX_TTL_SECONDS}`,
      'invalid',
    );
  const tenantId = safeId(owner.tenantId, 'the tenant');
  const db = await getShellDb();
  const links = await ReceiveLinkCollection.create({ db });
  const secret = randomBytes(32).toString('base64url');
  const tokenHash = hashOf(secret).toString('hex');
  const expiresAt = new Date(now() + ttlSeconds * 1000).toISOString();
  // One live token per tenant, by construction: the tenant has ONE row (its id
  // is derived from the tenant), and a mint rewrites it, which revokes the
  // earlier token. Two overlapping mints meet on that row (the database
  // serializes the UPDATE; the first insert wins the primary key), so the last
  // write leaves exactly one live token and the other caller's token is dead.
  const id = slotId(tenantId);
  const rewrite = async (): Promise<boolean> =>
    (
      await db.query(
        'UPDATE receive_links SET owner_id = ?, scope = ?, token_hash = ?, expires_at = ?, used_at = ? WHERE id = ? AND tenant_id = ? RETURNING id',
        owner.id,
        RECEIVE_SCOPE,
        tokenHash,
        expiresAt,
        '',
        id,
        tenantId,
      )
    ).rows.length === 1;
  if (!(await rewrite())) {
    try {
      const row = await links.create({
        id,
        ownerId: owner.id,
        scope: RECEIVE_SCOPE,
        tokenHash,
        expiresAt,
        usedAt: '',
      });
      await row.save();
    } catch (error) {
      // Lost the insert to an overlapping mint: rewrite its row instead.
      if (!(await rewrite())) throw error;
    }
  }
  return {
    token: `${TOKEN_PREFIX}.${tenantId}.${secret}`,
    expiresAt,
    scope: RECEIVE_SCOPE,
  };
}

/**
 * Check a presented token without spending it: well formed, a stored unspent
 * row of that tenant with the same secret (constant-time), the right scope,
 * not expired. Null for every failure.
 */
export async function verifyReceiveLink(
  presented: string,
  now: () => number = Date.now,
): Promise<VerifiedReceiveLink | null> {
  try {
    await requireCloudProfile('Receiving a user app');
    const m = TOKEN.exec(presented);
    if (!m) return null;
    const tenantId = safeId(m[1], 'the tenant');
    const want = hashOf(m[2]);
    return await runAs({ id: LOOKUP_USER, tenantId }, async () => {
      const links = await ReceiveLinkCollection.create({
        db: await getShellDb(),
      });
      const open = await links.list({ where: { usedAt: '' }, limit: 100 });
      // Every candidate is compared, none short-circuits.
      let found: (typeof open)[number] | null = null;
      for (const row of open) {
        const have = Buffer.from(String(row.tokenHash), 'hex');
        const same = have.length === want.length && timingSafeEqual(have, want);
        if (same) found = row;
      }
      if (
        !found ||
        (found as { tenantId?: unknown }).tenantId !== tenantId ||
        found.scope !== RECEIVE_SCOPE ||
        !(Date.parse(found.expiresAt) > now())
      )
        return null;
      return {
        id: found.id as string,
        tenantId,
        ownerId: found.ownerId,
        tokenHash: want.toString('hex'),
      };
    });
  } catch {
    return null;
  }
}

/** Spend the token: true for exactly one caller, ever. */
export async function spendReceiveLink(
  link: VerifiedReceiveLink,
  now: () => number = Date.now,
): Promise<boolean> {
  return runAs({ id: LOOKUP_USER, tenantId: link.tenantId }, async () => {
    const db = await getShellDb();
    // One conditional statement is the authority across processes. Raw SQL
    // bypasses the tenant interceptor, so the tenant is named here too.
    // Expiry is decided here too: the body may take a while to arrive after
    // the token verified. Both stamps are UTC ISO strings, which order as text.
    const stamp = new Date(now()).toISOString();
    const spent = await db.query(
      'UPDATE receive_links SET used_at = ? WHERE id = ? AND used_at = ? AND tenant_id = ? AND token_hash = ? AND expires_at > ? RETURNING id',
      stamp,
      link.id,
      '',
      link.tenantId,
      link.tokenHash,
      stamp,
    );
    return spent.rows.length === 1;
  });
}

/**
 * The verified owner a spent token acts as: the person who minted it, only
 * while they still hold the owner role of its tenant. Never read from the token
 * itself beyond the tenant selector.
 */
export async function ownerOfReceiveLink(
  link: VerifiedReceiveLink,
): Promise<Principal> {
  try {
    return await requireOwner({ id: link.ownerId, tenantId: link.tenantId });
  } catch (error) {
    if (error instanceof PolicyError) throw new PolicyError(401, INVALID);
    throw error;
  }
}

export const RECEIVE_LINK_INVALID = INVALID;
