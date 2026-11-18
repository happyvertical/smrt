/** Tenant-scoped QuickBooks connection: rotation, reconnect state, revoke (#5136). */
import { getTestDatabase } from '@happyvertical/smrt-core';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AccountingConnectionDeps,
  type AccountingSecretStore,
  completeQuickBooksConnection,
  disconnectQuickBooks,
  getAccountingConnection,
  QUICKBOOKS_REFRESH_TOKEN_SECRET,
  type TenantQuickBooksProvider,
  withTenantQuickBooksProvider,
} from '../accounting-connection.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

class FakeSecrets implements AccountingSecretStore {
  readonly rows = new Map<string, string>();
  private key(t: string, n: string) {
    return `${t}:${n}`;
  }
  async storeForTenant(t: string, n: string, v: string) {
    // Yield, like a real encrypted write, so interleavings are possible.
    await new Promise((r) => setTimeout(r, 1));
    this.rows.set(this.key(t, n), v);
  }
  async retrieveForTenant(t: string, n: string) {
    const v = this.rows.get(this.key(t, n));
    if (v === undefined) throw new Error('not found');
    return { value: v };
  }
  async deleteForTenant(t: string, n: string) {
    return this.rows.delete(this.key(t, n));
  }
}

/** An Intuit stand-in whose refresh tokens are single use and rotate. */
class FakeIntuit {
  valid = new Set<string>();
  revoked: string[] = [];
  refreshCalls = 0;
  private counter = 0;
  issue(): string {
    const token = `rt-${++this.counter}`;
    this.valid.add(token);
    return token;
  }
  async refresh(token: string) {
    this.refreshCalls += 1;
    await new Promise((r) => setTimeout(r, 5));
    if (!this.valid.delete(token))
      throw Object.assign(new Error('rejected'), { code: 'REAUTH_REQUIRED' });
    return {
      accessToken: 'at',
      refreshToken: this.issue(),
      expiresAt: new Date(),
    };
  }
}

function fakeProviderFactory(intuit: FakeIntuit) {
  return (options: {
    refreshToken: string;
    onTokenRefresh?: (t: {
      accessToken: string;
      refreshToken: string;
      expiresAt: Date;
    }) => Promise<void>;
  }): TenantQuickBooksProvider => ({
    async ensureAccessToken() {
      const tokens = await intuit.refresh(options.refreshToken);
      await options.onTokenRefresh?.(tokens);
      return tokens.accessToken;
    },
  });
}

describe('accounting connection (#5136)', () => {
  let db: DatabaseInterface;
  let secrets: FakeSecrets;
  let intuit: FakeIntuit;
  let deps: AccountingConnectionDeps;

  const config = () => ({
    ...deps,
    clientCredentials: () => ({ clientId: 'app', clientSecret: 'app-secret' }),
    createProvider: fakeProviderFactory(intuit) as never,
  });

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    enableTenancy();
    secrets = new FakeSecrets();
    intuit = new FakeIntuit();
    deps = { db, secrets, pollMs: 2, waitMs: 5_000, leaseMs: 60_000 };
  });
  afterEach(async () => {
    disableTenancy();
    await db.close?.();
  });

  async function connect(tenantId = TENANT, realmId = 'realm-1') {
    return completeQuickBooksConnection(deps, {
      tenantId,
      realmId,
      environment: 'sandbox',
      tokens: { refreshToken: intuit.issue() },
      connectedBy: 'user-1',
    });
  }

  it('binds the callback realm and environment at tenant level; token only in secrets', async () => {
    const connection = await connect();
    expect(connection).toMatchObject({
      tenantId: TENANT,
      provider: 'quickbooks',
      realmId: 'realm-1',
      environment: 'sandbox',
      status: 'connected',
      connectedBy: 'user-1',
      tokenVersion: 1,
      leaseToken: '',
    });
    expect(
      secrets.rows.get(`${TENANT}:${QUICKBOOKS_REFRESH_TOKEN_SECRET}`),
    ).toBe('rt-1');
    const rows = (await db.query('SELECT * FROM accounting_connections')).rows;
    expect(JSON.stringify(rows)).not.toContain('rt-1');
    // One row per tenant+provider: reconnecting rebinds it, even to a new company.
    const again = await completeQuickBooksConnection(deps, {
      tenantId: TENANT,
      realmId: 'realm-2',
      environment: 'production',
      tokens: { refreshToken: intuit.issue() },
    });
    expect(again.id).toBe(connection.id);
    expect(again).toMatchObject({
      realmId: 'realm-2',
      environment: 'production',
    });
    expect(
      (await db.query('SELECT id FROM accounting_connections')).rows,
    ).toHaveLength(1);
  });

  it('keeps connections per tenant', async () => {
    await connect(TENANT, 'realm-a');
    await connect(OTHER, 'realm-b');
    expect((await getAccountingConnection(deps, TENANT))?.realmId).toBe(
      'realm-a',
    );
    expect((await getAccountingConnection(deps, OTHER))?.realmId).toBe(
      'realm-b',
    );
  });

  it('serializes concurrent refreshes so single-use tokens are never reused', async () => {
    await connect();
    let used = 0;
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        withTenantQuickBooksProvider(config(), TENANT, async () => {
          used += 1;
          return 'ok';
        }),
      ),
    );
    expect(results).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(used).toBe(4);
    expect(intuit.refreshCalls).toBe(4);
    const connection = await getAccountingConnection(deps, TENANT);
    expect(connection?.status).toBe('connected');
    expect(connection?.tokenVersion).toBe(5);
    // The stored token is the last one issued, and it is still valid.
    const stored = secrets.rows.get(
      `${TENANT}:${QUICKBOOKS_REFRESH_TOKEN_SECRET}`,
    );
    expect(stored).toBe('rt-5');
    expect(intuit.valid.has('rt-5')).toBe(true);
    expect(connection?.leaseToken).toBe('');
  });

  it('without the lease the same fixture loses a token (control)', async () => {
    const token = intuit.issue();
    const [a, b] = await Promise.allSettled([
      intuit.refresh(token),
      intuit.refresh(token),
    ]);
    expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected']);
  });

  it('moves to needs_reconnect on invalid_grant and stops serving providers', async () => {
    await connect();
    intuit.valid.clear(); // consent revoked at Intuit
    await expect(
      withTenantQuickBooksProvider(config(), TENANT, async () => 'never'),
    ).rejects.toMatchObject({ code: 'NEEDS_RECONNECT' });
    const connection = await getAccountingConnection(deps, TENANT);
    expect(connection).toMatchObject({
      status: 'needs_reconnect',
      lastError: 'REAUTH_REQUIRED',
    });
    expect(connection?.lastErrorAt).toBeInstanceOf(Date);
    expect(JSON.stringify(connection?.toJSON())).not.toContain('rt-');
    expect(connection?.leaseToken).toBe('');
    // Fails fast without calling Intuit again.
    const calls = intuit.refreshCalls;
    await expect(
      withTenantQuickBooksProvider(config(), TENANT, async () => 'never'),
    ).rejects.toMatchObject({ code: 'NEEDS_RECONNECT' });
    expect(intuit.refreshCalls).toBe(calls);
    // Reconnecting clears the error.
    await connect();
    const healed = await getAccountingConnection(deps, TENANT);
    expect(healed).toMatchObject({ status: 'connected', lastError: '' });
    await expect(
      withTenantQuickBooksProvider(config(), TENANT, async () => 'ok'),
    ).resolves.toBe('ok');
  });

  it('does not flag a connection whose stored token rotated while the failure happened', async () => {
    await connect();
    let first = true;
    const flaky = {
      ...config(),
      createProvider: ((options: {
        refreshToken: string;
        onTokenRefresh: never;
      }) => {
        const real = fakeProviderFactory(intuit)(options as never);
        return {
          async ensureAccessToken() {
            if (first) {
              first = false;
              // Another writer rotated the stored token, then this call failed.
              secrets.rows.set(
                `${TENANT}:${QUICKBOOKS_REFRESH_TOKEN_SECRET}`,
                intuit.issue(),
              );
              throw Object.assign(new Error('x'), { code: 'REAUTH_REQUIRED' });
            }
            return real.ensureAccessToken();
          },
        };
      }) as never,
    };
    await expect(
      withTenantQuickBooksProvider(flaky, TENANT, async () => 'ok'),
    ).resolves.toBe('ok');
    expect((await getAccountingConnection(deps, TENANT))?.status).toBe(
      'connected',
    );
  });

  it('refuses a provider when not connected', async () => {
    await expect(
      withTenantQuickBooksProvider(config(), TENANT, async () => 'x'),
    ).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });

  it('times out instead of hanging when another owner holds the lease', async () => {
    const connection = await connect();
    await db.query(
      "UPDATE accounting_connections SET lease_token = 'other', lease_expires_at = ? WHERE id = ?",
      new Date(Date.now() + 60_000).toISOString(),
      connection.id,
    );
    await expect(
      withTenantQuickBooksProvider(
        { ...config(), waitMs: 30 },
        TENANT,
        async () => 'x',
      ),
    ).rejects.toMatchObject({ code: 'LEASE_TIMEOUT' });
  });

  it('takes over a lapsed lease', async () => {
    const connection = await connect();
    await db.query(
      "UPDATE accounting_connections SET lease_token = 'dead', lease_expires_at = ? WHERE id = ?",
      new Date(Date.now() - 1000).toISOString(),
      connection.id,
    );
    await expect(
      withTenantQuickBooksProvider(config(), TENANT, async () => 'ok'),
    ).resolves.toBe('ok');
  });

  it('disconnect revokes, deletes the secret, and keeps the row', async () => {
    const connection = await connect();
    const revoked: string[] = [];
    const result = await disconnectQuickBooks(deps, {
      tenantId: TENANT,
      oauth: {
        revoke: async ({ refreshToken }) => void revoked.push(refreshToken),
      },
    });
    expect(revoked).toEqual(['rt-1']);
    expect(secrets.rows.size).toBe(0);
    expect(result).toMatchObject({
      id: connection.id,
      status: 'disconnected',
      realmId: 'realm-1',
    });
    expect(result.disconnectedAt).toBeInstanceOf(Date);
    // Idempotent; no second revoke without a secret.
    await disconnectQuickBooks(deps, {
      tenantId: TENANT,
      oauth: { revoke: async () => void revoked.push('again') },
    });
    expect(revoked).toEqual(['rt-1']);
    await expect(
      withTenantQuickBooksProvider(config(), TENANT, async () => 'x'),
    ).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    // The model is never deleted.
    await expect(result.delete()).rejects.toThrow(/cannot be deleted/);
  });

  it('a failed revoke leaves the connection and secret intact; a dead grant still disconnects', async () => {
    await connect();
    await expect(
      disconnectQuickBooks(deps, {
        tenantId: TENANT,
        oauth: { revoke: async () => Promise.reject(new Error('network')) },
      }),
    ).rejects.toMatchObject({ code: 'REVOKE_FAILED' });
    expect((await getAccountingConnection(deps, TENANT))?.status).toBe(
      'connected',
    );
    expect(secrets.rows.size).toBe(1);
    const result = await disconnectQuickBooks(deps, {
      tenantId: TENANT,
      oauth: {
        revoke: async () =>
          Promise.reject(
            Object.assign(new Error('x'), { code: 'REAUTH_REQUIRED' }),
          ),
      },
    });
    expect(result.status).toBe('disconnected');
    expect(secrets.rows.size).toBe(0);
  });

  it('refuses writes outside the commands', async () => {
    const connection = await connect();
    connection.realmId = 'forged';
    await expect(connection.save()).rejects.toThrow(
      /only by the accounting-connection commands/,
    );
  });
});
