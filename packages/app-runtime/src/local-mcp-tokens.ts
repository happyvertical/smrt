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

/** Runtime-owned system table; ignored by schema diff, parity and portability. */
export const LOCAL_MCP_TOKEN_TABLE = '_smrt_local_mcp_tokens';
/** Prefix of every local MCP token (aids secret scanning). */
export const LOCAL_MCP_TOKEN_PREFIX = 'smrt_mcp_';
/** Default token lifetime: 30 days. */
export const DEFAULT_LOCAL_MCP_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Longest token lifetime: 365 days. There is no non-expiring token. */
export const MAX_LOCAL_MCP_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;

const MAX_SCOPES = 64;
const MAX_SCOPE_LENGTH = 128;
const MAX_LABEL_LENGTH = 80;
const SCOPE_PATTERN = /^[\x21\x23-\x5b\x5d-\x7e]+$/u;
const TOKEN_PATTERN = /^smrt_mcp_[A-Za-z0-9_-]{43}$/u;
const TOKEN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/** Domain separation from the owner-bootstrap HMAC sharing the same secret. */
const HMAC_DOMAIN = 'smrt.local-mcp-token.v1\0';

/** Input for {@link LocalMcpTokenStore.issue}. */
export interface IssueLocalMcpTokenInput {
  /** Permission slugs the token may use. Each must be held by the owner. */
  readonly scopes: readonly string[];
  /**
   * Lifetime in whole seconds, 60..{@link MAX_LOCAL_MCP_TOKEN_TTL_SECONDS}.
   * Defaults to {@link DEFAULT_LOCAL_MCP_TOKEN_TTL_SECONDS}.
   */
  readonly expiresInSeconds?: number;
  /** Operator note shown by `list()` (printable, at most 80 characters). */
  readonly label?: string;
}

/** The one-time result of {@link LocalMcpTokenStore.issue}. */
export interface IssuedLocalMcpToken {
  /** Public token id used by `list()`/`revoke()`; not a credential. */
  readonly id: string;
  /** The bearer credential. Shown once; only its HMAC is stored. */
  readonly token: string;
  readonly scopes: readonly string[];
  readonly label: string | null;
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
  readonly createdAt: string;
  readonly expiresAt: string;
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

/** Owner-scoped local MCP token operations. */
export interface LocalMcpTokenStore {
  /** Mint a token bound to the local owner's user and tenant. */
  issue(input: IssueLocalMcpTokenInput): Promise<IssuedLocalMcpToken>;
  /** Every stored token, newest first, without token values or hashes. */
  list(): Promise<LocalMcpTokenRecord[]>;
  /** Revoke a token by id. Repeating it is a no-op. Unknown ids throw. */
  revoke(id: string): Promise<'revoked' | 'already-revoked'>;
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
  created_at?: unknown;
  expires_at?: unknown;
  revoked_at?: unknown;
}

/** Create the runtime-owned token table if it does not exist. */
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
      revoked_at TEXT NULL
    )`,
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

  return Object.freeze({
    async issue(input: IssueLocalMcpTokenInput): Promise<IssuedLocalMcpToken> {
      const scopes = normalizeScopes(input?.scopes, fail);
      const ttl =
        input?.expiresInSeconds ?? DEFAULT_LOCAL_MCP_TOKEN_TTL_SECONDS;
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
      const label = normalizeLabel(input?.label, fail);
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
      await db.query(
        `INSERT INTO ${LOCAL_MCP_TOKEN_TABLE}
          (id, token_hash, user_id, tenant_id, scopes, label, created_at, expires_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        id,
        await hashToken(token),
        owner.userId,
        owner.tenantId,
        JSON.stringify(scopes),
        label,
        createdAt,
        expiresAt,
      );
      return Object.freeze({
        id,
        token,
        scopes: Object.freeze([...scopes]),
        label,
        createdAt,
        expiresAt,
      });
    },

    async list(): Promise<LocalMcpTokenRecord[]> {
      await ensureLocalMcpTokenTable(db);
      const result = await db.query(
        `SELECT id, scopes, label, created_at, expires_at, revoked_at
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
          createdAt: String(row.created_at),
          expiresAt,
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

    async verify(token: string): Promise<LocalMcpTokenPrincipal | null> {
      // Reject garbage before any secret read or database access.
      if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;
      const result = await db.query(
        `SELECT id, user_id, tenant_id, scopes, expires_at, revoked_at
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

function normalizeLabel(
  value: string | undefined,
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
      'An MCP token label must be 1-80 printable characters.',
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
