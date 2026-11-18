/**
 * AccountingConnection — a tenant's connection to one accounting provider
 * (QuickBooks Online) (#5136).
 *
 * Tenant-level, not user-owned: one row per `(tenant, provider)`. The OAuth
 * refresh token is never a column; it lives in smrt-secrets. The row keeps the
 * company (`realmId`), the environment, a connection status, the last error
 * code, and the per-connection refresh lease that serializes token rotation.
 *
 * Commands live in `accounting-connection.ts`; this model only guards its own
 * identity. See `agents/accounting-connection.md`.
 *
 * @packageDocumentation
 */

import {
  field,
  type SmrtDeleteOptions,
  SmrtObject,
  type SmrtObjectOptions,
  type SmrtSaveOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

/** Accounting providers a connection can name. */
export type AccountingConnectionProvider = 'quickbooks';

/** Provider mode. Sandbox and production companies never mix. */
export type AccountingConnectionEnvironment = 'sandbox' | 'production';

/**
 * Connection standing.
 *
 * - `connected`: tokens are held and the last refresh succeeded.
 * - `needs_reconnect`: the provider rejected the grant (`invalid_grant`:
 *   revoked consent or an expired refresh token); the user must reconnect.
 * - `disconnected`: revoked at the provider and the secret deleted; the row and
 *   its sync history stay.
 */
export type AccountingConnectionStatus =
  | 'connected'
  | 'needs_reconnect'
  | 'disconnected';

/** Constructor options for {@link AccountingConnection}. */
export interface AccountingConnectionOptions extends SmrtObjectOptions {
  tenantId?: string;
  provider?: AccountingConnectionProvider;
  realmId?: string;
  environment?: AccountingConnectionEnvironment;
  status?: AccountingConnectionStatus;
}

const PROVIDERS: readonly AccountingConnectionProvider[] = ['quickbooks'];
const ENVIRONMENTS: readonly AccountingConnectionEnvironment[] = [
  'sandbox',
  'production',
];
const STATUSES: readonly AccountingConnectionStatus[] = [
  'connected',
  'needs_reconnect',
  'disconnected',
];

/** Rows being written by an accounting-connection command. */
const commandWriteInProgress = new WeakSet<AccountingConnection>();

/** @internal Run a write owned by the accounting-connection commands. */
export async function writeAccountingConnection<T>(
  connection: AccountingConnection,
  write: () => Promise<T>,
): Promise<T> {
  commandWriteInProgress.add(connection);
  try {
    return await write();
  } finally {
    commandWriteInProgress.delete(connection);
  }
}

/**
 * A tenant's connection to an accounting provider.
 *
 * Unique on `(tenantId, provider)`: one connection per tenant and provider.
 * Reconnecting reuses the row (the company may change); disconnecting keeps it.
 * The generated surface is read-only: the row is created, rebound, refreshed
 * and disconnected only through the accounting-connection commands, and never
 * deleted.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'accounting_connections',
  indexes: [
    {
      name: 'accounting_connections_tenant_provider',
      columns: ['tenantId', 'provider'],
      unique: true,
    },
  ],
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: { include: ['list', 'get', 'isConnected'], skipApiCheck: true },
})
export class AccountingConnection extends SmrtObject {
  /** Tenant that owns the connection. */
  @tenantId()
  tenantId: string = '';

  /** Accounting provider. */
  provider: AccountingConnectionProvider = 'quickbooks';

  /** Provider company id (QuickBooks `realmId`); empty before the first connect. */
  realmId: string = '';

  /** Provider mode of the connected company. */
  environment: AccountingConnectionEnvironment = 'sandbox';

  /** Standing; see {@link AccountingConnectionStatus}. */
  status: AccountingConnectionStatus = 'disconnected';

  /** Short error code of the last failure (never provider text or tokens). */
  lastError: string = '';

  /** When {@link lastError} was recorded. */
  @field({ type: 'datetime', nullable: true })
  lastErrorAt: Date | null = null;

  /** Who completed the connect (an opaque user reference), if known. */
  connectedBy: string = '';

  /** When the current connection was completed. */
  @field({ type: 'datetime', nullable: true })
  connectedAt: Date | null = null;

  /** When the connection was last revoked and its secret deleted. */
  @field({ type: 'datetime', nullable: true })
  disconnectedAt: Date | null = null;

  /** Incremented on every persisted token rotation; never the token itself. */
  tokenVersion: number = 0;

  /** When tokens were last refreshed and persisted. */
  @field({ type: 'datetime', nullable: true })
  lastRefreshedAt: Date | null = null;

  /** Owner of the refresh lease (random token), or empty. Command-owned. */
  @field({ sensitive: true })
  leaseToken: string = '';

  /** ISO instant the refresh lease lapses, or empty. Command-owned. */
  @field({ sensitive: true })
  leaseExpiresAt: string = '';

  constructor(options: AccountingConnectionOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.provider !== undefined) this.provider = options.provider;
    if (options.realmId !== undefined) this.realmId = options.realmId;
    if (options.environment !== undefined)
      this.environment = options.environment;
    if (options.status !== undefined) this.status = options.status;
  }

  /** Whether the connection can currently make provider calls. */
  isConnected(): boolean {
    return this.status === 'connected';
  }

  /** Refuses writes outside the commands and any change of tenant or provider. */
  override async save(options?: SmrtSaveOptions): Promise<this> {
    if (!commandWriteInProgress.has(this))
      throw new Error(
        'AccountingConnection is written only by the accounting-connection commands',
      );
    if (!this.tenantId)
      throw new Error('AccountingConnection requires a tenant');
    if (!PROVIDERS.includes(this.provider))
      throw new Error('AccountingConnection provider is invalid');
    if (!ENVIRONMENTS.includes(this.environment))
      throw new Error(
        'AccountingConnection environment must be sandbox or production',
      );
    if (!STATUSES.includes(this.status))
      throw new Error('AccountingConnection status is invalid');
    if (this.status === 'connected' && !this.realmId)
      throw new Error('A connected AccountingConnection requires a realmId');
    if (this.id) {
      const prior = await this.getCanonicalPersistedRow({ id: this.id });
      if (prior) {
        const identity: Array<[string, unknown, unknown]> = [
          ['tenantId', String(prior.tenant_id ?? ''), this.tenantId],
          ['provider', String(prior.provider ?? ''), this.provider],
        ];
        for (const [name, before, after] of identity)
          if (String(before).toLowerCase() !== String(after).toLowerCase())
            throw new Error(`AccountingConnection ${name} cannot change`);
      }
    }
    return super.save(options);
  }

  /** Never deleted: it owns sync history. Use the disconnect command. */
  override async delete(_options?: SmrtDeleteOptions): Promise<void> {
    throw new Error(
      'AccountingConnection cannot be deleted; disconnect it instead',
    );
  }
}

export default AccountingConnection;
