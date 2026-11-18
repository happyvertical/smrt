/** Accounting mapping records (#5137) that need no invoices, so they also run on PGlite. */
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getAccountingMapping,
  getAccountingMappingScope,
  listAccountingMappings,
  removeAccountingMapping,
  setAccountingMapping,
} from '../accounting-mapping.js';
import {
  connectFixtureTenant,
  FakeSecrets,
} from './helpers/accounting-fixtures.js';

const databaseType = process.env.SMRT_TEST_PGLITE === '1' ? 'pglite' : 'sqlite';
const TENANT = '66666666-6666-4666-8666-666666666661';
const OTHER = '66666666-6666-4666-8666-666666666662';

describe('accounting mapping records (#5137)', () => {
  let db: DatabaseInterface;
  let secrets: FakeSecrets;

  beforeEach(async () => {
    db = await getTestDatabase({ type: databaseType, url: ':memory:' });
    enableTenancy();
    secrets = new FakeSecrets();
  });
  afterEach(async () => {
    disableTenancy();
    await db.close?.();
  });

  it('scopes mappings by tenant, realm and environment, and upserts per key', async () => {
    await connectFixtureTenant(db, TENANT, { secrets });
    const scope = await getAccountingMappingScope({ db }, TENANT);
    await setAccountingMapping({ db }, scope, {
      kind: 'item',
      localId: 'default',
      externalId: 'i-1',
    });
    expect(
      (await getAccountingMapping({ db }, scope, 'item', 'default'))
        ?.externalId,
    ).toBe('i-1');
    for (const other of [
      { ...scope, realmId: 'realm-b' },
      { ...scope, environment: 'production' as const },
      { ...scope, tenantId: OTHER },
    ])
      expect(
        await getAccountingMapping({ db }, other, 'item', 'default'),
      ).toBeNull();
    await setAccountingMapping({ db }, scope, {
      kind: 'item',
      localId: 'default',
      externalId: 'i-2',
    });
    expect(await listAccountingMappings({ db }, scope, 'item')).toHaveLength(1);
    expect(
      (await getAccountingMapping({ db }, scope, 'item', 'default'))
        ?.externalId,
    ).toBe('i-2');
    expect(
      await removeAccountingMapping({ db }, scope, 'item', 'default'),
    ).toBe(true);
    expect(
      await removeAccountingMapping({ db }, scope, 'item', 'default'),
    ).toBe(false);
  });

  it('invalidates, never reuses, mappings when the company or environment changes', async () => {
    await connectFixtureTenant(db, TENANT, { secrets });
    const scope = await getAccountingMappingScope({ db }, TENANT);
    await setAccountingMapping({ db }, scope, {
      kind: 'item',
      localId: 'default',
      externalId: 'i-1',
    });
    await setAccountingMapping({ db }, scope, {
      kind: 'customer',
      localId: 'c-1',
      externalId: 'qb-1',
    });
    await connectFixtureTenant(db, TENANT, { realmId: 'realm-b', secrets });
    const rows = (await db.query('SELECT status FROM accounting_mappings'))
      .rows as Array<{ status: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'invalidated')).toBe(true);
    const moved = await getAccountingMappingScope({ db }, TENANT);
    expect(moved.realmId).toBe('realm-b');
    expect(await listAccountingMappings({ db }, moved)).toHaveLength(0);
    expect(
      await getAccountingMapping({ db }, scope, 'item', 'default'),
    ).toBeNull();
    // The other tenant's mappings are untouched by this tenant's rebind.
    await connectFixtureTenant(db, OTHER, { secrets });
    const otherScope = await getAccountingMappingScope({ db }, OTHER);
    await setAccountingMapping({ db }, otherScope, {
      kind: 'item',
      localId: 'default',
      externalId: 'o-1',
    });
    await connectFixtureTenant(db, TENANT, {
      realmId: 'realm-b',
      environment: 'production',
      secrets,
    });
    expect(
      (await getAccountingMapping({ db }, otherScope, 'item', 'default'))
        ?.externalId,
    ).toBe('o-1');
    // Setting again in a scope reactivates the row with the new reference.
    const back = await getAccountingMappingScope({ db }, TENANT);
    await setAccountingMapping({ db }, back, {
      kind: 'item',
      localId: 'default',
      externalId: 'i-9',
    });
    expect(
      (await getAccountingMapping({ db }, back, 'item', 'default'))?.externalId,
    ).toBe('i-9');
  });

  it('refuses direct writes to a mapping', async () => {
    await connectFixtureTenant(db, TENANT, { secrets });
    const scope = await getAccountingMappingScope({ db }, TENANT);
    const row = await setAccountingMapping({ db }, scope, {
      kind: 'item',
      localId: 'default',
      externalId: 'i-1',
    });
    row.externalId = 'forged';
    await expect(
      withTenant({ tenantId: TENANT }, () => row.save()),
    ).rejects.toThrow(/only by the accounting-mapping commands/);
    await expect(
      withTenant({ tenantId: TENANT }, () => row.delete()),
    ).rejects.toThrow(/only by removeAccountingMapping/);
  });
});
