/**
 * Tenant-scoped accounting connection commands (#5136).
 *
 * A tenant connects one QuickBooks Online company. The refresh token lives in
 * smrt-secrets (through the {@link AccountingSecretStore} port), never in a
 * column. Intuit rotates the refresh token on every refresh, and a fresh
 * `QuickBooksProvider` refreshes on its first call, so two concurrent users of
 * the same stored token lose one of them. Every rotation therefore runs under a
 * per-connection lease (`leaseToken`/`leaseExpiresAt` on the row): taken with a
 * conditional `UPDATE`, never held across a database transaction, and renewed
 * only by its owner. Waiters poll up to a bound instead of failing.
 *
 * Nothing here talks to Intuit directly: the host injects the OAuth client
 * ({@link AccountingOAuthPort}) and the provider constructor, so fixtures
 * can stand in for both. See `agents/accounting-connection.md`.
 *
 * @packageDocumentation
 */

import { randomUUID } from 'node:crypto';
import type {
  AccountingProvider,
  QuickBooksOptions,
  TokenSet,
} from '@happyvertical/accounting';
import { getAccountingProvider } from '@happyvertical/accounting';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { invalidateAccountingMappingsOutside } from './accounting-mapping.js';
import { AccountingConnectionCollection } from './collections/AccountingConnectionCollection.js';
import {
  type AccountingConnection,
  type AccountingConnectionEnvironment,
  writeAccountingConnection,
} from './models/AccountingConnection.js';

/** smrt-secrets category for accounting tokens. */
export const ACCOUNTING_SECRET_CATEGORY = 'accounting.quickbooks';

/** Name of the tenant's QuickBooks refresh-token secret. */
export const QUICKBOOKS_REFRESH_TOKEN_SECRET =
  'accounting-quickbooks-refresh-token';

/** Why an accounting-connection command refused. Messages never carry tokens. */
export type AccountingConnectionErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_CONNECTED'
  | 'NEEDS_RECONNECT'
  | 'LEASE_TIMEOUT'
  | 'REVOKE_FAILED';

/** Typed refusal from an accounting-connection command. */
export class AccountingConnectionError extends Error {
  readonly code: AccountingConnectionErrorCode;

  constructor(code: AccountingConnectionErrorCode, message: string) {
    super(message);
    this.name = 'AccountingConnectionError';
    this.code = code;
  }
}

/**
 * The slice of smrt-secrets the connection needs. `SecretService` from
 * `@happyvertical/smrt-secrets` satisfies it.
 */
export interface AccountingSecretStore {
  /** Store (upsert) a secret for the tenant. */
  storeForTenant(
    tenantId: string,
    name: string,
    value: string,
    options?: { category?: string; description?: string },
  ): Promise<unknown>;
  /** Read a secret for the tenant; rejects when it does not exist. */
  retrieveForTenant(tenantId: string, name: string): Promise<{ value: string }>;
  /** Delete a secret for the tenant; `false` when absent. */
  deleteForTenant(tenantId: string, name: string): Promise<boolean>;
}

/**
 * The slice of the SDK's `QuickBooksOAuthClient` the connection needs
 * (`createQuickBooksOAuthClient`). `refresh` arrives with happyvertical/sdk#1541.
 */
export interface AccountingOAuthPort {
  /** Revoke a refresh token at the provider. */
  revoke(input: { refreshToken: string }): Promise<void>;
}

/** Shared dependencies of the connection commands. */
export interface AccountingConnectionDeps {
  readonly db: DatabaseInterface;
  readonly secrets: AccountingSecretStore;
  /** Lease lifetime in ms (default 120 000). */
  readonly leaseMs?: number;
  /** Longest a caller waits for a held lease in ms (default 30 000). */
  readonly waitMs?: number;
  /** Poll interval while waiting for a lease in ms (default 50). */
  readonly pollMs?: number;
  /** Clock override for tests. */
  readonly now?: () => Date;
}

const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_WAIT_MS = 30_000;
const DEFAULT_POLL_MS = 50;
const TABLE = 'accounting_connections';

function invalid(message: string): AccountingConnectionError {
  return new AccountingConnectionError('INVALID_INPUT', message);
}

function requireTenant(tenantId: string): string {
  if (
    typeof tenantId !== 'string' ||
    !tenantId.trim() ||
    tenantId.trim() !== tenantId
  )
    throw invalid('Accounting connection requires a tenant id');
  return tenantId;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.trim() !== value)
    throw invalid(`${label} must be a nonempty trimmed string`);
  return value;
}

function now(deps: AccountingConnectionDeps): Date {
  return deps.now ? deps.now() : new Date();
}

/**
 * Whether a provider error means the grant is dead and the user must reconnect.
 * Structural on purpose: `AccountingReauthRequiredError` (sdk#1541) carries
 * `code === 'REAUTH_REQUIRED'`; a raw OAuth `invalid_grant` is treated alike.
 */
export function isReauthRequired(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: unknown; name?: unknown; error?: unknown };
  return (
    e.code === 'REAUTH_REQUIRED' ||
    e.name === 'AccountingReauthRequiredError' ||
    e.error === 'invalid_grant' ||
    e.code === 'invalid_grant'
  );
}

function collection(deps: AccountingConnectionDeps) {
  return AccountingConnectionCollection.create({ db: deps.db });
}

async function findConnection(
  deps: AccountingConnectionDeps,
  tenantId: string,
): Promise<AccountingConnection | null> {
  return withTenant({ tenantId }, async () =>
    (await collection(deps)).findForTenant({
      tenantId,
      provider: 'quickbooks',
    }),
  );
}

/** The tenant's QuickBooks connection record, or `null` (read-only). */
export async function getAccountingConnection(
  deps: Pick<AccountingConnectionDeps, 'db'>,
  tenantId: string,
): Promise<AccountingConnection | null> {
  requireTenant(tenantId);
  return findConnection(deps as AccountingConnectionDeps, tenantId);
}

/** Find the row, creating a `disconnected` one when the tenant has none. */
async function ensureConnection(
  deps: AccountingConnectionDeps,
  tenantId: string,
): Promise<AccountingConnection> {
  const existing = await findConnection(deps, tenantId);
  if (existing) return existing;
  try {
    return await withTenant({ tenantId }, async () => {
      const connection = await (await collection(deps)).build({
        tenantId,
        provider: 'quickbooks',
        status: 'disconnected',
      });
      return writeAccountingConnection(connection, () => connection.save());
    });
  } catch (error) {
    // A concurrent first connect created it: the unique index refused us.
    const raced = await findConnection(deps, tenantId);
    if (raced) return raced;
    throw error;
  }
}

async function tryAcquireLease(
  deps: AccountingConnectionDeps,
  tenantId: string,
  connectionId: string,
  token: string,
): Promise<boolean> {
  const at = now(deps);
  const nowIso = at.toISOString();
  const expires = new Date(
    at.getTime() + (deps.leaseMs ?? DEFAULT_LEASE_MS),
  ).toISOString();
  const result = await deps.db.query(
    `UPDATE ${TABLE}
        SET lease_token = ?, lease_expires_at = ?
      WHERE id = ? AND tenant_id = ?
        AND (lease_token IS NULL OR lease_token = '' OR lease_expires_at IS NULL
             OR lease_expires_at = '' OR lease_expires_at < ?)
      RETURNING id`,
    token,
    expires,
    connectionId,
    tenantId,
    nowIso,
  );
  return result.rows.length === 1;
}

async function releaseLease(
  deps: AccountingConnectionDeps,
  tenantId: string,
  connectionId: string,
  token: string,
): Promise<void> {
  await deps.db.query(
    `UPDATE ${TABLE}
        SET lease_token = '', lease_expires_at = ''
      WHERE id = ? AND tenant_id = ? AND lease_token = ?`,
    connectionId,
    tenantId,
    token,
  );
}

/** Extend a held lease; `false` when it lapsed and another owner may hold it. */
async function renewLease(
  deps: AccountingConnectionDeps,
  tenantId: string,
  connectionId: string,
  token: string,
): Promise<boolean> {
  const expires = new Date(
    now(deps).getTime() + (deps.leaseMs ?? DEFAULT_LEASE_MS),
  ).toISOString();
  const result = await deps.db.query(
    `UPDATE ${TABLE} SET lease_expires_at = ?
      WHERE id = ? AND tenant_id = ? AND lease_token = ?
      RETURNING id`,
    expires,
    connectionId,
    tenantId,
    token,
  );
  return result.rows.length === 1;
}

/** Run `work` while holding the connection's lease, waiting a bounded time. */
async function withLease<T>(
  deps: AccountingConnectionDeps,
  tenantId: string,
  connectionId: string,
  work: (lease: { token: string; renew(): Promise<boolean> }) => Promise<T>,
): Promise<T> {
  const token = randomUUID();
  const waitMs = deps.waitMs ?? DEFAULT_WAIT_MS;
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const startedAt = Date.now();
  while (!(await tryAcquireLease(deps, tenantId, connectionId, token))) {
    if (Date.now() - startedAt >= waitMs)
      throw new AccountingConnectionError(
        'LEASE_TIMEOUT',
        'Another process holds this accounting connection; retry later',
      );
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  try {
    return await work({
      token,
      renew: () => renewLease(deps, tenantId, connectionId, token),
    });
  } finally {
    await releaseLease(deps, tenantId, connectionId, token);
  }
}

/** Reload the row inside the lease and save a mutation of it. */
async function mutateConnection(
  deps: AccountingConnectionDeps,
  tenantId: string,
  mutate: (connection: AccountingConnection) => void,
): Promise<AccountingConnection> {
  return withTenant({ tenantId }, async () => {
    const connection = await (await collection(deps)).findForTenant({
      tenantId,
      provider: 'quickbooks',
    });
    if (!connection)
      throw new AccountingConnectionError(
        'NOT_CONNECTED',
        'No accounting connection',
      );
    mutate(connection);
    return writeAccountingConnection(connection, () => connection.save());
  });
}

function clearLiveEnablement(row: AccountingConnection): void {
  row.liveEnabledRealmId = '';
  row.liveEnabledAt = null;
  row.liveEnabledBy = '';
  row.liveEnabledEvidenceRef = '';
}

/** Input of {@link completeQuickBooksConnection}. */
export interface CompleteQuickBooksConnectionInput {
  readonly tenantId: string;
  /** The company the user authorized (from the OAuth callback). */
  readonly realmId: string;
  /** The environment the callback was issued for. */
  readonly environment: AccountingConnectionEnvironment;
  /** The token exchange result; only the refresh token is retained. */
  readonly tokens: Pick<TokenSet, 'refreshToken'>;
  /** Opaque reference of the user who connected, for audit. */
  readonly connectedBy?: string;
}

/**
 * Bind a completed QuickBooks OAuth callback to the tenant (the completion hook
 * for the shared connect flow, smrt#5128). The callback supplies the `realmId`,
 * environment and exchanged tokens; the connection is tenant-level, so no user
 * owns it. Stores the refresh token in smrt-secrets, then marks the row
 * `connected` and clears any error. Reconnecting rebinds the same row (the
 * company may differ) under the refresh lease, so an in-flight refresh cannot
 * overwrite the fresh token.
 */
export async function completeQuickBooksConnection(
  deps: AccountingConnectionDeps,
  input: CompleteQuickBooksConnectionInput,
): Promise<AccountingConnection> {
  const tenantId = requireTenant(input.tenantId);
  const realmId = requireText(input.realmId, 'QuickBooks realmId');
  if (input.environment !== 'sandbox' && input.environment !== 'production')
    throw invalid('QuickBooks environment must be sandbox or production');
  const refreshToken = requireText(input.tokens?.refreshToken, 'Refresh token');
  const connection = await ensureConnection(deps, tenantId);
  await withLease(deps, tenantId, String(connection.id), async () => {
    await deps.secrets.storeForTenant(
      tenantId,
      QUICKBOOKS_REFRESH_TOKEN_SECRET,
      refreshToken,
      {
        category: ACCOUNTING_SECRET_CATEGORY,
        description: 'QuickBooks Online refresh token',
      },
    );
    const at = now(deps);
    const rebound =
      connection.realmId !== '' &&
      (connection.realmId !== realmId ||
        connection.environment !== input.environment);
    await mutateConnection(deps, tenantId, (row) => {
      row.realmId = realmId;
      row.environment = input.environment;
      row.status = 'connected';
      row.lastError = '';
      row.lastErrorAt = null;
      row.connectedBy = input.connectedBy ?? '';
      row.connectedAt = at;
      row.disconnectedAt = null;
      row.lastRefreshedAt = at;
      row.tokenVersion += 1;
      // Live enablement belongs to one company and environment (#5138).
      if (rebound) clearLiveEnablement(row);
    });
    // Mappings of the company or environment the tenant left are never reused.
    if (rebound)
      await invalidateAccountingMappingsOutside(
        deps,
        {
          tenantId,
          provider: 'quickbooks',
          realmId,
          environment: input.environment,
        },
        at,
      );
  });
  return (await findConnection(deps, tenantId)) as AccountingConnection;
}

/** Host configuration for {@link withTenantQuickBooksProvider}. */
export interface TenantQuickBooksProviderConfig
  extends AccountingConnectionDeps {
  /** The Intuit app credentials (the host's own secrets; never stored here). */
  readonly clientCredentials: () =>
    | { clientId: string; clientSecret: string; redirectUri?: string }
    | Promise<{ clientId: string; clientSecret: string; redirectUri?: string }>;
  /** Provider factory; defaults to the SDK's `getAccountingProvider`. */
  readonly createProvider?: (
    options: QuickBooksOptions,
  ) => TenantQuickBooksProvider;
}

/**
 * A `QuickBooksProvider` as the SDK factory returns it: the accounting provider
 * plus the public `ensureAccessToken()` this module drives. Fixtures implement
 * the `ensureAccessToken` slice with single-use refresh tokens.
 */
export type TenantQuickBooksProvider = AccountingProvider & {
  /** Refresh the access token if needed; reports rotation via `onTokenRefresh`. */
  ensureAccessToken(): Promise<string>;
};

async function readRefreshToken(
  deps: AccountingConnectionDeps,
  tenantId: string,
): Promise<string> {
  try {
    const { value } = await deps.secrets.retrieveForTenant(
      tenantId,
      QUICKBOOKS_REFRESH_TOKEN_SECRET,
    );
    if (typeof value !== 'string' || !value) throw new Error('empty');
    return value;
  } catch {
    throw new AccountingConnectionError(
      'NOT_CONNECTED',
      'The accounting connection has no stored credentials',
    );
  }
}

async function markNeedsReconnect(
  deps: AccountingConnectionDeps,
  tenantId: string,
): Promise<void> {
  const at = now(deps);
  await mutateConnection(deps, tenantId, (row) => {
    row.status = 'needs_reconnect';
    row.lastError = 'REAUTH_REQUIRED';
    row.lastErrorAt = at;
  });
}

/**
 * Run `fn` with a ready `QuickBooksProvider` for the tenant's connection, so
 * the app never handles tokens.
 *
 * The refresh runs under the connection lease: the stored token is read inside
 * the lease, the provider refreshes (`ensureAccessToken`), and the rotated token
 * is persisted through `onTokenRefresh` before the lease is released. `fn` then
 * runs on the already-fresh provider outside the lease. A rejected grant
 * (`invalid_grant`, surfaced by the SDK as a `REAUTH_REQUIRED` error) is
 * re-checked against the stored token under the lease and, if it was the
 * current one, moves the connection to `needs_reconnect` and throws
 * `NEEDS_RECONNECT` instead of failing jobs silently.
 *
 * Seam (sdk): a provider seeded with a valid access token would not refresh on
 * first use; today a new provider always refreshes once, so this is a lease
 * around each provider's first call.
 */
export async function withTenantQuickBooksProvider<T>(
  config: TenantQuickBooksProviderConfig,
  tenantId: string,
  fn: (provider: TenantQuickBooksProvider) => Promise<T>,
): Promise<T> {
  requireTenant(tenantId);
  const connection = await findConnection(config, tenantId);
  if (!connection || connection.status === 'disconnected')
    throw new AccountingConnectionError(
      'NOT_CONNECTED',
      'No accounting connection',
    );
  if (connection.status === 'needs_reconnect')
    throw new AccountingConnectionError(
      'NEEDS_RECONNECT',
      'The accounting connection must be reconnected',
    );
  const connectionId = String(connection.id);
  const credentials = await config.clientCredentials();
  const build =
    config.createProvider ??
    (async (options: QuickBooksOptions) =>
      (await getAccountingProvider(options)) as TenantQuickBooksProvider);

  const provider = await withLease<TenantQuickBooksProvider>(
    config,
    tenantId,
    connectionId,
    async (lease) => {
      // Re-read inside the lease: status or company may have changed while waiting.
      const current = await findConnection(config, tenantId);
      if (current?.status !== 'connected')
        throw new AccountingConnectionError(
          current?.status === 'needs_reconnect'
            ? 'NEEDS_RECONNECT'
            : 'NOT_CONNECTED',
          'The accounting connection is not usable',
        );
      let attempt = 0;
      for (;;) {
        attempt += 1;
        const usedToken = await readRefreshToken(config, tenantId);
        const candidate = await build({
          type: 'quickbooks',
          clientId: credentials.clientId,
          clientSecret: credentials.clientSecret,
          redirectUri: credentials.redirectUri,
          realmId: current.realmId,
          environment: current.environment,
          refreshToken: usedToken,
          onTokenRefresh: async (tokens) => {
            // Persist the rotated token before anything can use the new access
            // token. Persist even if the lease lapsed: the newest token wins.
            await lease.renew();
            await config.secrets.storeForTenant(
              tenantId,
              QUICKBOOKS_REFRESH_TOKEN_SECRET,
              tokens.refreshToken,
              { category: ACCOUNTING_SECRET_CATEGORY },
            );
            const at = now(config);
            await mutateConnection(config, tenantId, (row) => {
              row.tokenVersion += 1;
              row.lastRefreshedAt = at;
              row.lastError = '';
              row.lastErrorAt = null;
            });
          },
        });
        try {
          await candidate.ensureAccessToken();
          return candidate;
        } catch (error) {
          if (!isReauthRequired(error)) throw error;
          const stored = await readRefreshToken(config, tenantId);
          if (stored !== usedToken && attempt < 2) continue; // rotated meanwhile
          await markNeedsReconnect(config, tenantId);
          throw new AccountingConnectionError(
            'NEEDS_RECONNECT',
            'QuickBooks rejected the authorization; the tenant must reconnect',
          );
        }
      }
    },
  );
  return fn(provider);
}

/** Input of {@link disconnectQuickBooks}. */
export interface DisconnectQuickBooksInput {
  readonly tenantId: string;
  /** The SDK OAuth client used to revoke the refresh token at Intuit. */
  readonly oauth: AccountingOAuthPort;
}

/**
 * Disconnect: revoke the refresh token at Intuit, delete the secret, mark the
 * row `disconnected`. The row (and the sync history keyed to it) is kept. Runs
 * under the refresh lease so a refresh cannot resurrect the deleted secret. A
 * grant the provider already rejects counts as revoked; any other revoke
 * failure throws `REVOKE_FAILED` and leaves the connection untouched so the
 * call can be retried. Idempotent.
 */
export async function disconnectQuickBooks(
  deps: AccountingConnectionDeps,
  input: DisconnectQuickBooksInput,
): Promise<AccountingConnection> {
  const tenantId = requireTenant(input.tenantId);
  const connection = await findConnection(deps, tenantId);
  if (!connection)
    throw new AccountingConnectionError(
      'NOT_CONNECTED',
      'No accounting connection',
    );
  await withLease(deps, tenantId, String(connection.id), async () => {
    let refreshToken: string | null = null;
    try {
      refreshToken = await readRefreshToken(deps, tenantId);
    } catch {
      refreshToken = null; // already deleted
    }
    if (refreshToken) {
      try {
        await input.oauth.revoke({ refreshToken });
      } catch (error) {
        if (!isReauthRequired(error))
          throw new AccountingConnectionError(
            'REVOKE_FAILED',
            'QuickBooks token revocation failed; the connection is unchanged',
          );
      }
      await deps.secrets.deleteForTenant(
        tenantId,
        QUICKBOOKS_REFRESH_TOKEN_SECRET,
      );
    }
    const at = now(deps);
    await mutateConnection(deps, tenantId, (row) => {
      row.status = 'disconnected';
      row.disconnectedAt = at;
      clearLiveEnablement(row);
      row.lastError = '';
      row.lastErrorAt = null;
    });
  });
  return (await findConnection(deps, tenantId)) as AccountingConnection;
}

/** Input of {@link enableLiveAccounting}. */
export interface EnableLiveAccountingInput {
  readonly tenantId: string;
  /** The company being enabled; must equal the connected one. */
  readonly realmId: string;
  /** Who is enabling live writes (an opaque user reference). */
  readonly enabledBy: string;
  /** Reference to the evidence that justified it (for example a sandbox report). */
  readonly evidenceRef: string;
}

/**
 * Deliberately enable production accounting writes for the tenant's connected
 * company (#5138). Requires a `connected` **production** connection to the named
 * company; the gate in the sync functions stays closed otherwise. Enablement is
 * per company: rebinding the connection or disconnecting clears it.
 */
export async function enableLiveAccounting(
  deps: AccountingConnectionDeps,
  input: EnableLiveAccountingInput,
): Promise<AccountingConnection> {
  const tenantId = requireTenant(input.tenantId);
  const realmId = requireText(input.realmId, 'QuickBooks realmId');
  const enabledBy = requireText(input.enabledBy, 'Enabled by');
  const evidenceRef = requireText(input.evidenceRef, 'Evidence reference');
  const connection = await findConnection(deps, tenantId);
  if (
    !connection ||
    connection.status !== 'connected' ||
    connection.environment !== 'production' ||
    connection.realmId !== realmId
  )
    throw new AccountingConnectionError(
      'NOT_CONNECTED',
      'Live accounting needs a connected production company with that realm',
    );
  await withLease(deps, tenantId, String(connection.id), async () => {
    const at = now(deps);
    await mutateConnection(deps, tenantId, (row) => {
      if (
        row.status !== 'connected' ||
        row.environment !== 'production' ||
        row.realmId !== realmId
      )
        throw new AccountingConnectionError(
          'NOT_CONNECTED',
          'Live accounting needs a connected production company with that realm',
        );
      row.liveEnabledRealmId = realmId;
      row.liveEnabledAt = at;
      row.liveEnabledBy = enabledBy;
      row.liveEnabledEvidenceRef = evidenceRef;
    });
  });
  return (await findConnection(deps, tenantId)) as AccountingConnection;
}

/** Switch production accounting writes off again. Idempotent. */
export async function disableLiveAccounting(
  deps: AccountingConnectionDeps,
  tenantId: string,
): Promise<AccountingConnection | null> {
  requireTenant(tenantId);
  const connection = await findConnection(deps, tenantId);
  if (!connection) return null;
  await withLease(deps, tenantId, String(connection.id), async () => {
    await mutateConnection(deps, tenantId, clearLiveEnablement);
  });
  return findConnection(deps, tenantId);
}
