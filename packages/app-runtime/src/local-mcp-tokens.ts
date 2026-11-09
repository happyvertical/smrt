/**
 * Owner-minted bearer tokens for local MCP clients (`local` profile only).
 *
 * A token is a random 256-bit value with a fixed prefix. The runtime stores
 * only a domain-separated HMAC of it (keyed by the local application secret)
 * in the runtime-owned `_smrt_local_mcp_tokens` system table, alongside the
 * owner's user and tenant, the granted scopes and the expiry. The plaintext
 * is returned exactly once, by `issue()`.
 *
 * A token never carries more authority than its owner holds *now*: `issue()`
 * refuses scopes the owner does not currently hold, and `verify()` returns
 * the token's scopes intersected with the owner's live permissions from its
 * active direct membership in the bound tenant (inherited authority never
 * substitutes for it; no such membership, an inactive user, a revoked or an
 * expired token all yield `null`). Routes should still bind the principal with
 * `runtime.runAsPrincipal`, which applies the same intersection inside the
 * request permission context.
 */

import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
  MembershipCollection,
  PermissionResolver,
  UserCollection,
  UserStatus,
} from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';
import { resolveBoundMembershipPermissions } from './direct-membership.js';
import { deepFrozenPlainCopy, ownValue, PlainDataError } from './plain-data.js';

/** Runtime-owned system table; ignored by schema diff, parity and portability. */
export const LOCAL_MCP_TOKEN_TABLE = '_smrt_local_mcp_tokens';
/** Prefix of every local MCP token (aids secret scanning). */
export const LOCAL_MCP_TOKEN_PREFIX = 'smrt_mcp_';
/**
 * Window of a renewable token (issued without `expiresInSeconds`): 30 days.
 * Each successful `verify()` slides the expiry to now + this window, so a
 * token lapses only after a full unused window.
 */
export const DEFAULT_LOCAL_MCP_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Longest token lifetime: 365 days. There is no non-expiring token. */
export const MAX_LOCAL_MCP_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;

const MAX_SCOPES = 64;
const MAX_SCOPE_LENGTH = 128;
const MAX_LABEL_LENGTH = 80;
/** A renewable token writes its slide at most this often (per token). */
const SLIDE_WRITE_INTERVAL_MS = 60 * 60 * 1000;
/** Columns added after the first release; added idempotently to old tables. */
const LATER_COLUMNS = [
  ['holder', 'TEXT NULL'],
  ['sliding', 'INTEGER NULL'],
  ['last_used_at', 'TEXT NULL'],
] as const;
const HOLDER_INDEX = `${LOCAL_MCP_TOKEN_TABLE}_active_holder`;
const SCOPE_PATTERN = /^[\x21\x23-\x5b\x5d-\x7e]+$/u;
const TOKEN_PATTERN = /^smrt_mcp_[A-Za-z0-9_-]{43}$/u;
const DESKTOP_SLOT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DESKTOP_SLOT_LABEL = 'Desktop integration';
const TOKEN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/** Domain separation from the owner-bootstrap HMAC sharing the same secret. */
const HMAC_DOMAIN = 'smrt.local-mcp-token.v1\0';

/** Input for {@link LocalMcpTokenStore.issue}. */
export interface IssueLocalMcpTokenInput {
  /** Permission slugs the token may use. Each must be held by the owner. */
  readonly scopes: readonly string[];
  /**
   * Fixed lifetime in whole seconds, 60..{@link MAX_LOCAL_MCP_TOKEN_TTL_SECONDS}.
   * The token never slides. Omit it for a renewable token: a
   * {@link DEFAULT_LOCAL_MCP_TOKEN_TTL_SECONDS} window that each successful
   * `verify()` slides forward (written at most once an hour).
   */
  readonly expiresInSeconds?: number;
  /** Operator note shown by `list()` (printable, at most 80 characters). */
  readonly label?: string;
  /**
   * Short printable id (at most 80 characters) of the device or client that
   * holds the token. A holder has at most one active token: issuing for a
   * holder that already has one rotates it, revoking the previous token in the
   * same transaction as the new one is stored.
   */
  readonly holder?: string;
}

/** The one-time result of {@link LocalMcpTokenStore.issue}. */
export interface IssuedLocalMcpToken {
  /** Public token id used by `list()`/`revoke()`; not a credential. */
  readonly id: string;
  /** The bearer credential. Shown once; only its HMAC is stored. */
  readonly token: string;
  readonly scopes: readonly string[];
  readonly label: string | null;
  readonly holder: string | null;
  /** True when verification slides the expiry (no fixed lifetime was asked). */
  readonly renewable: boolean;
  readonly createdAt: string;
  readonly expiresAt: string;
}

/** Lifecycle state of a stored token. */
export type LocalMcpTokenStatus = 'active' | 'expired' | 'revoked';

/** Secret-free token metadata returned by {@link LocalMcpTokenStore.list}. */
export interface LocalMcpTokenRecord {
  readonly id: string;
  readonly scopes: readonly string[];
  readonly label: string | null;
  readonly holder: string | null;
  /** Renewable tokens slide on use; fixed-lifetime (and legacy) ones do not. */
  readonly renewable: boolean;
  readonly createdAt: string;
  readonly expiresAt: string;
  /** When the expiry last slid (hour granularity); null if never or fixed. */
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
  readonly status: LocalMcpTokenStatus;
}

/**
 * Brand on every principal `verify()` returns. It is an enumerable symbol, so
 * a spread copy keeps it and `runAsPrincipal` can refuse any attempt to widen
 * the binding of a token-derived principal.
 *
 * @internal
 */
export const LOCAL_MCP_TOKEN_PRINCIPAL: unique symbol = Symbol.for(
  '@happyvertical/smrt-app-runtime/local-mcp-token-principal',
);

/**
 * A verified token principal, structurally an MCP app principal. `scopes`
 * are the token scopes the owner still holds in `tenantId`. The object is
 * frozen (its `scopes` array too) and always binds `direct`: passed straight to `runAsPrincipal`, it
 * is authorized only by the owner's active direct membership in `tenantId`.
 * A copy that sets any other `tenantBinding` is rejected, not ignored.
 */
export interface LocalMcpTokenPrincipal {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: 'human';
  /** Frozen: token scopes ∩ live permissions at verification. */
  readonly scopes: readonly string[];
  readonly tenantBinding: 'direct';
  /** @internal Token provenance brand; see {@link LOCAL_MCP_TOKEN_PRINCIPAL}. */
  readonly [LOCAL_MCP_TOKEN_PRINCIPAL]: true;
}

/** True for a principal derived from a verified local MCP token. */
export function isLocalMcpTokenPrincipal(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[LOCAL_MCP_TOKEN_PRINCIPAL] === true
  );
}

/** Credential management input for an authenticated desktop owner session. */
export type LocalMcpDesktopCredentialInput =
  | {
      readonly action: 'put';
      readonly id: string;
      readonly scopes: readonly string[];
      readonly expiresInSeconds: number;
    }
  | { readonly action: 'revoke'; readonly id: string };

/** Verified server-side session snapshot, never supplied by the client. */
export interface LocalMcpDesktopOwnerSession {
  readonly userId: string;
  readonly tenantId: string;
  readonly permissions: readonly string[];
}

/** Owner-scoped local MCP token operations. */
export interface LocalMcpTokenStore {
  /** Mint a token bound to the local owner's user and tenant. */
  issue(input: IssueLocalMcpTokenInput): Promise<IssuedLocalMcpToken>;
  /** Manage one desktop slot as the sole active local owner. */
  manageDesktopCredential?(
    session: LocalMcpDesktopOwnerSession,
    input: LocalMcpDesktopCredentialInput,
  ): Promise<IssuedLocalMcpToken | 'revoked' | 'slot_unavailable'>;
  /** Every stored token, newest first, without token values or hashes. */
  list(): Promise<LocalMcpTokenRecord[]>;
  /** Revoke a token by id. Repeating it is a no-op. Unknown ids throw. */
  revoke(id: string): Promise<'revoked' | 'already-revoked'>;
  /**
   * Revoke every unrevoked token of a holder. Idempotent: `'none'` when the
   * holder has nothing left to revoke (including an unknown holder).
   */
  revokeHolder(holder: string): Promise<'revoked' | 'none'>;
  /**
   * Resolve a presented token to its principal, or `null` (fail closed) for
   * a malformed, unknown, revoked or expired token, or an owner whose user or
   * membership is no longer active.
   */
  verify(token: string): Promise<LocalMcpTokenPrincipal | null>;
}

/** @internal Collaborators supplied by the local runtime. */
export interface LocalMcpTokenStoreDependencies {
  readonly db: DatabaseInterface;
  /** Read the local application secret (validated custody). */
  readonly readSecret: () => Promise<string>;
  readonly now: () => Date;
  /** The active local owner, or `null` before owner setup. */
  readonly findOwner: (
    db: DatabaseInterface,
    requireUnique?: boolean,
  ) => Promise<{ userId: string; tenantId: string } | null>;
  /** Build the stable, secret-free runtime error. */
  readonly fail: (
    code: 'invalid_scope' | 'owner_unavailable' | 'invalid_configuration',
    message: string,
  ) => Error;
}

interface TokenRow {
  id?: unknown;
  user_id?: unknown;
  tenant_id?: unknown;
  scopes?: unknown;
  label?: unknown;
  holder?: unknown;
  sliding?: unknown;
  created_at?: unknown;
  expires_at?: unknown;
  last_used_at?: unknown;
  revoked_at?: unknown;
}

/**
 * Create the runtime-owned token table if it does not exist, add the columns
 * later releases introduced (`holder`, `sliding`, `last_used_at`) to an older
 * table, and enforce one unrevoked token per holder with a partial unique
 * index. Idempotent and safe to race. Rows from before the upgrade have no
 * holder and are not renewable. The local profile is SQLite-only.
 */
export async function ensureLocalMcpTokenTable(
  db: DatabaseInterface,
): Promise<void> {
  await db.query(
    `CREATE TABLE IF NOT EXISTS ${LOCAL_MCP_TOKEN_TABLE} (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      scopes TEXT NOT NULL,
      label TEXT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT NULL,
      holder TEXT NULL,
      sliding INTEGER NULL,
      last_used_at TEXT NULL
    )`,
  );
  const present = async (): Promise<Set<string>> =>
    new Set(
      (
        (await db.query(`PRAGMA table_info(${LOCAL_MCP_TOKEN_TABLE})`))
          .rows as Array<{ name?: unknown }>
      ).map((column) => String(column.name)),
    );
  let columns = await present();
  for (const [name, type] of LATER_COLUMNS) {
    if (columns.has(name)) continue;
    try {
      await db.query(
        `ALTER TABLE ${LOCAL_MCP_TOKEN_TABLE} ADD COLUMN ${name} ${type}`,
      );
    } catch (error) {
      // Another process may have added it first.
      columns = await present();
      if (!columns.has(name)) throw error;
    }
  }
  await db.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS ${HOLDER_INDEX}
     ON ${LOCAL_MCP_TOKEN_TABLE} (holder)
     WHERE holder IS NOT NULL AND revoked_at IS NULL`,
  );
}

/** @internal Build the store over an open local database. */
export function createLocalMcpTokenStore(
  deps: LocalMcpTokenStoreDependencies,
): LocalMcpTokenStore {
  const { db, now, fail } = deps;
  let keyPromise: Promise<Buffer> | undefined;
  const hashKey = (): Promise<Buffer> => {
    keyPromise ??= deps
      .readSecret()
      .then((secret) =>
        createHmac('sha256', secret.trim()).update(HMAC_DOMAIN).digest(),
      )
      .catch((error: unknown) => {
        keyPromise = undefined;
        throw error;
      });
    return keyPromise;
  };
  const hashToken = async (token: string): Promise<string> =>
    createHmac('sha256', await hashKey())
      .update(token)
      .digest('hex');

  let resolverPromise: Promise<PermissionResolver> | undefined;
  /**
   * Live permissions from the owner's active *direct* membership in exactly
   * this tenant (pinned; inheritance never substitutes), or `null`.
   */
  const livePermissions = async (
    userId: string,
    tenantId: string,
  ): Promise<ReadonlySet<string> | null> => {
    resolverPromise ??= PermissionResolver.create({ db }).catch(
      (error: unknown) => {
        resolverPromise = undefined;
        throw error;
      },
    );
    const resolved = await resolveBoundMembershipPermissions({
      memberships: await MembershipCollection.create({ db }),
      resolver: await resolverPromise,
      userId,
      tenantId,
      binding: 'direct',
    });
    return resolved?.permissions ?? null;
  };

  /**
   * Slide a renewable token's expiry to now + window, at most once an hour.
   * The conditional UPDATE never revives an expired or revoked token and never
   * shortens an expiry. Best effort: a failed write leaves the token valid
   * until its current expiry rather than failing the request.
   */
  const slideExpiry = async (id: string, row: TokenRow): Promise<void> => {
    const current = now().getTime();
    const last = Date.parse(String(row.last_used_at ?? ''));
    if (Number.isFinite(last) && current - last < SLIDE_WRITE_INTERVAL_MS) {
      return;
    }
    const nowIso = new Date(current).toISOString();
    const slidTo = new Date(
      current + DEFAULT_LOCAL_MCP_TOKEN_TTL_SECONDS * 1000,
    ).toISOString();
    try {
      await db.query(
        `UPDATE ${LOCAL_MCP_TOKEN_TABLE}
         SET expires_at = ?, last_used_at = ?
         WHERE id = ? AND sliding = 1 AND revoked_at IS NULL
           AND expires_at > ? AND expires_at < ?`,
        slidTo,
        nowIso,
        id,
        nowIso,
        slidTo,
      );
    } catch {
      // Keep serving the verified request; the next verification retries.
    }
  };

  return Object.freeze<LocalMcpTokenStore>({
    async issue(input: IssueLocalMcpTokenInput): Promise<IssuedLocalMcpToken> {
      // Own plain data only: inherited or poisoned fields never set scopes,
      // lifetime or label.
      let fields: object;
      try {
        fields = deepFrozenPlainCopy(input ?? {}) as object;
      } catch (error) {
        if (!(error instanceof PlainDataError)) throw error;
        throw fail(
          'invalid_configuration',
          `MCP token input ${error.message}.`,
        );
      }
      if (fields === null || typeof fields !== 'object') {
        throw fail(
          'invalid_configuration',
          'MCP token input must be an object.',
        );
      }
      const scopes = normalizeScopes(
        ownValue(fields, 'scopes') as readonly string[] | undefined,
        fail,
      );
      const fixedTtl = ownValue(fields, 'expiresInSeconds') as
        | number
        | undefined;
      // No explicit lifetime: a renewable token over the default window.
      const renewable = fixedTtl === undefined || fixedTtl === null;
      const ttl = fixedTtl ?? DEFAULT_LOCAL_MCP_TOKEN_TTL_SECONDS;
      validateTtl(ttl, fail);
      const label = normalizeText(
        ownValue(fields, 'label') as string | undefined,
        'label',
        fail,
      );
      const holder = normalizeText(
        ownValue(fields, 'holder') as string | undefined,
        'holder',
        fail,
      );
      const owner = await deps.findOwner(db);
      if (!owner) {
        throw fail(
          'owner_unavailable',
          'No local owner exists yet; finish owner setup before issuing MCP tokens.',
        );
      }
      const held = await livePermissions(owner.userId, owner.tenantId);
      const missing = scopes.filter((scope) => !held?.has(scope));
      if (missing.length > 0) {
        throw fail(
          'invalid_scope',
          `The local owner does not hold: ${missing.join(', ')}.`,
        );
      }
      await ensureLocalMcpTokenTable(db);
      const token = `${LOCAL_MCP_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
      const id = randomUUID();
      const created = now();
      const createdAt = created.toISOString();
      const expiresAt = new Date(created.getTime() + ttl * 1000).toISOString();
      const tokenHash = await hashToken(token);
      const insert = (executor: Pick<DatabaseInterface, 'query'>) =>
        executor.query(
          `INSERT INTO ${LOCAL_MCP_TOKEN_TABLE}
            (id, token_hash, user_id, tenant_id, scopes, label, created_at, expires_at, revoked_at, holder, sliding, last_used_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)`,
          id,
          tokenHash,
          owner.userId,
          owner.tenantId,
          JSON.stringify(scopes),
          label,
          createdAt,
          expiresAt,
          holder,
          renewable ? 1 : 0,
        );
      if (holder === null) {
        await insert(db);
      } else {
        if (typeof db.transaction !== 'function') {
          throw fail(
            'invalid_configuration',
            'Rotating a holder token requires a database adapter with transaction support.',
          );
        }
        // The previous token is revoked and the new one stored together: a
        // failure leaves the previous token valid, success leaves only the
        // new one. The partial unique index backstops a concurrent writer.
        await db.transaction(async (tx) => {
          await tx.query(
            `UPDATE ${LOCAL_MCP_TOKEN_TABLE}
             SET revoked_at = ?
             WHERE holder = ? AND revoked_at IS NULL`,
            createdAt,
            holder,
          );
          await insert(tx);
        });
      }
      return Object.freeze({
        id,
        token,
        scopes: Object.freeze([...scopes]),
        label,
        holder,
        renewable,
        createdAt,
        expiresAt,
      });
    },

    async manageDesktopCredential(session, input) {
      // Desktop callers submit UUIDv4 slot handles. The corresponding UUIDv8
      // row id cannot collide with the UUIDv4 ids generated by issue().
      let request: LocalMcpDesktopCredentialInput;
      try {
        request = deepFrozenPlainCopy(input) as LocalMcpDesktopCredentialInput;
      } catch (error) {
        if (!(error instanceof PlainDataError)) throw error;
        throw fail('invalid_configuration', 'Invalid desktop MCP input.');
      }
      if (
        typeof request?.id !== 'string' ||
        !DESKTOP_SLOT_ID_PATTERN.test(request.id)
      ) {
        throw fail('invalid_configuration', 'Invalid desktop MCP slot id.');
      }
      const id = `${request.id.slice(0, 14)}8${request.id.slice(15)}`;
      const { userId, tenantId, permissions } = session;
      const allowed = new Set(permissions);
      const owner = await deps.findOwner(db, true);
      if (!owner || owner.userId !== userId || owner.tenantId !== tenantId) {
        throw fail('owner_unavailable', 'The local owner session is required.');
      }
      const users = await UserCollection.create({ db });
      const user = await users.get({ id: owner.userId });
      const held = await livePermissions(owner.userId, owner.tenantId);
      if (!user?.isActive() || !held) {
        throw fail('owner_unavailable', 'The local owner session is required.');
      }

      const created = now();
      const createdAt = created.toISOString();
      if (request.action === 'revoke') {
        // Tombstone even an unused slot so a delayed PUT cannot recreate it.
        // The placeholder hash does not correspond to an issued bearer.
        const result = await db.query(
          `INSERT INTO ${LOCAL_MCP_TOKEN_TABLE}
             (id, token_hash, user_id, tenant_id, scopes, label, created_at, expires_at, revoked_at)
           VALUES (?, ?, ?, ?, '[]', ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET revoked_at =
             coalesce(${LOCAL_MCP_TOKEN_TABLE}.revoked_at, excluded.revoked_at)
           WHERE ${LOCAL_MCP_TOKEN_TABLE}.user_id = excluded.user_id
             AND ${LOCAL_MCP_TOKEN_TABLE}.tenant_id = excluded.tenant_id
           RETURNING id`,
          id,
          randomBytes(32).toString('hex'),
          owner.userId,
          owner.tenantId,
          DESKTOP_SLOT_LABEL,
          createdAt,
          createdAt,
          createdAt,
        );
        return result.rows.length > 0 ? 'revoked' : 'slot_unavailable';
      }
      if (request.action !== 'put') {
        throw fail('invalid_configuration', 'Invalid desktop MCP action.');
      }
      const scopes = normalizeScopes(request.scopes, fail);
      validateTtl(request.expiresInSeconds, fail);
      if (scopes.some((scope) => !held.has(scope) || !allowed.has(scope))) {
        throw fail('invalid_scope', 'Desktop MCP scopes are not authorized.');
      }
      const expiresAt = new Date(
        created.getTime() + request.expiresInSeconds * 1000,
      ).toISOString();
      const token = `${LOCAL_MCP_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
      // A single statement swaps the hash and scope/expiry together. Each
      // successful PUT generates a fresh bearer, with the latest write winning.
      const result = await db.query(
        `INSERT INTO ${LOCAL_MCP_TOKEN_TABLE}
           (id, token_hash, user_id, tenant_id, scopes, label, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           token_hash = excluded.token_hash, scopes = excluded.scopes,
           created_at = excluded.created_at, expires_at = excluded.expires_at
         WHERE ${LOCAL_MCP_TOKEN_TABLE}.revoked_at IS NULL
           AND ${LOCAL_MCP_TOKEN_TABLE}.user_id = excluded.user_id
           AND ${LOCAL_MCP_TOKEN_TABLE}.tenant_id = excluded.tenant_id
         RETURNING id`,
        id,
        await hashToken(token),
        owner.userId,
        owner.tenantId,
        JSON.stringify(scopes),
        DESKTOP_SLOT_LABEL,
        createdAt,
        expiresAt,
      );
      if (result.rows.length === 0) return 'slot_unavailable';
      return Object.freeze({
        id,
        token,
        scopes: Object.freeze(scopes),
        label: DESKTOP_SLOT_LABEL,
        holder: null,
        renewable: false,
        createdAt,
        expiresAt,
      });
    },

    async list(): Promise<LocalMcpTokenRecord[]> {
      await ensureLocalMcpTokenTable(db);
      const result = await db.query(
        `SELECT id, scopes, label, holder, sliding, created_at, expires_at,
                last_used_at, revoked_at
         FROM ${LOCAL_MCP_TOKEN_TABLE}
         ORDER BY created_at DESC, id`,
      );
      const current = now().getTime();
      return (result.rows as TokenRow[]).map((row) => {
        const expiresAt = String(row.expires_at);
        const revokedAt =
          row.revoked_at == null ? null : String(row.revoked_at);
        const status: LocalMcpTokenStatus = revokedAt
          ? 'revoked'
          : Date.parse(expiresAt) > current
            ? 'active'
            : 'expired';
        return Object.freeze({
          id: String(row.id),
          scopes: Object.freeze(parseScopes(row.scopes) ?? []),
          label: row.label == null ? null : String(row.label),
          holder: row.holder == null ? null : String(row.holder),
          renewable: isRenewable(row),
          createdAt: String(row.created_at),
          expiresAt,
          lastUsedAt:
            row.last_used_at == null ? null : String(row.last_used_at),
          revokedAt,
          status,
        });
      });
    },

    async revoke(id: string): Promise<'revoked' | 'already-revoked'> {
      if (typeof id !== 'string' || !TOKEN_ID_PATTERN.test(id)) {
        throw fail('invalid_configuration', 'Unknown MCP token id.');
      }
      await ensureLocalMcpTokenTable(db);
      const updated = await db.query(
        `UPDATE ${LOCAL_MCP_TOKEN_TABLE}
         SET revoked_at = ?
         WHERE id = ? AND revoked_at IS NULL
         RETURNING id`,
        now().toISOString(),
        id,
      );
      if (updated.rows.length > 0) return 'revoked';
      const existing = await db.query(
        `SELECT id FROM ${LOCAL_MCP_TOKEN_TABLE} WHERE id = ? LIMIT 1`,
        id,
      );
      if (existing.rows.length === 0) {
        throw fail('invalid_configuration', 'Unknown MCP token id.');
      }
      return 'already-revoked';
    },

    async revokeHolder(holder: string): Promise<'revoked' | 'none'> {
      const normalized = normalizeText(holder, 'holder', fail);
      if (normalized === null) {
        throw fail('invalid_configuration', 'An MCP token holder is required.');
      }
      await ensureLocalMcpTokenTable(db);
      const updated = await db.query(
        `UPDATE ${LOCAL_MCP_TOKEN_TABLE}
         SET revoked_at = ?
         WHERE holder = ? AND revoked_at IS NULL
         RETURNING id`,
        now().toISOString(),
        normalized,
      );
      return updated.rows.length > 0 ? 'revoked' : 'none';
    },

    async verify(token: string): Promise<LocalMcpTokenPrincipal | null> {
      // Reject garbage before any secret read or database access.
      if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;
      const result = await db.query(
        `SELECT id, user_id, tenant_id, scopes, sliding, expires_at,
                last_used_at, revoked_at
         FROM ${LOCAL_MCP_TOKEN_TABLE}
         WHERE token_hash = ?
         LIMIT 1`,
        await hashToken(token),
      );
      const row = result.rows[0] as TokenRow | undefined;
      if (!row || row.revoked_at != null) return null;
      const expiresAt = Date.parse(String(row.expires_at));
      if (!Number.isFinite(expiresAt) || expiresAt <= now().getTime()) {
        return null;
      }
      const userId = row.user_id;
      const tenantId = row.tenant_id;
      const scopes = parseScopes(row.scopes);
      if (
        typeof userId !== 'string' ||
        userId.length === 0 ||
        typeof tenantId !== 'string' ||
        tenantId.length === 0 ||
        !scopes
      ) {
        return null;
      }
      const users = await UserCollection.create({ db });
      const user = await users.get({ id: userId });
      if (!user || user.status !== UserStatus.ACTIVE) return null;
      const held = await livePermissions(userId, tenantId);
      if (!held) return null;
      if (isRenewable(row)) await slideExpiry(String(row.id), row);
      return Object.freeze({
        id: userId,
        tenantId,
        kind: 'human' as const,
        // A frozen copy: mutating it can never widen a later binding.
        scopes: Object.freeze(scopes.filter((scope) => held.has(scope))),
        tenantBinding: 'direct' as const,
        [LOCAL_MCP_TOKEN_PRINCIPAL]: true as const,
      });
    },
  });
}

function validateTtl(
  ttl: number,
  fail: LocalMcpTokenStoreDependencies['fail'],
): void {
  if (
    !Number.isSafeInteger(ttl) ||
    ttl < 60 ||
    ttl > MAX_LOCAL_MCP_TOKEN_TTL_SECONDS
  ) {
    throw fail(
      'invalid_configuration',
      'MCP token lifetime must be between one minute and 365 days.',
    );
  }
}

function normalizeScopes(
  value: readonly string[] | undefined,
  fail: LocalMcpTokenStoreDependencies['fail'],
): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw fail('invalid_scope', 'An MCP token needs at least one scope.');
  }
  if (value.length > MAX_SCOPES) {
    throw fail('invalid_scope', 'An MCP token may carry at most 64 scopes.');
  }
  for (const scope of value) {
    if (
      typeof scope !== 'string' ||
      scope.length > MAX_SCOPE_LENGTH ||
      !SCOPE_PATTERN.test(scope)
    ) {
      throw fail('invalid_scope', 'Invalid MCP token scope.');
    }
  }
  return [...new Set(value)].sort();
}

function isRenewable(row: TokenRow): boolean {
  // Rows from before sliding existed (NULL) are fixed.
  return Number(row.sliding) === 1;
}

function normalizeText(
  value: string | undefined,
  name: 'label' | 'holder',
  fail: LocalMcpTokenStoreDependencies['fail'],
): string | null {
  if (value === undefined) return null;
  const label = typeof value === 'string' ? value.trim() : '';
  if (
    label.length === 0 ||
    label.length > MAX_LABEL_LENGTH ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
    /[\u0000-\u001f\u007f]/u.test(label)
  ) {
    throw fail(
      'invalid_configuration',
      `An MCP token ${name} must be 1-80 printable characters.`,
    );
  }
  return label;
}

function parseScopes(value: unknown): string[] | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) &&
      parsed.every((scope) => typeof scope === 'string')
      ? (parsed as string[])
      : null;
  } catch {
    return null;
  }
}
