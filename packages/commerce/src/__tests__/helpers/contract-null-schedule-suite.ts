import { randomUUID } from 'node:crypto';
import { isPostgresDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { expect } from 'vitest';
import { ContractCollection } from '../../collections/ContractCollection.js';
import { CustomerCollection } from '../../collections/CustomerCollection.js';
import { upgradeCommerceMoney } from '../../index.js';
import { ContractStatus } from '../../types/index.js';

/**
 * Contracts as a writer from before `billing_schedule_json` defaulted to `''`
 * left them: the column is NULL (#4155).
 */
async function legacyContracts(
  db: DatabaseInterface,
  tenantId: string,
  count: number,
): Promise<string[]> {
  const ids = await withTenant({ tenantId }, async () => {
    const customer = await (await CustomerCollection.create({ db })).create({
      name: 'Pre-default customer',
    });
    const contracts = await ContractCollection.create({ db });
    const created: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const contract = await contracts.create({
        _meta_type: '@happyvertical/smrt-commerce:Order',
        customerId: String(customer.id),
        currency: 'CAD',
      });
      created.push(String(contract.id));
    }
    return created;
  });
  for (const id of ids)
    await db.query(
      'UPDATE contracts SET billing_schedule_json = NULL WHERE CAST(id AS TEXT) = ?',
      id,
    );
  for (const id of ids) expect(await storedSchedule(db, id)).toBeNull();
  return ids;
}

async function storedSchedule(
  db: DatabaseInterface,
  id: string,
): Promise<unknown> {
  // Read past any row policy a test forced on the table.
  const read = async (executor: DatabaseInterface) => {
    if (isPostgresDatabase(executor))
      await executor.query(
        "SELECT set_config('smrt.system_context', 'true', true)",
      );
    const result = await executor.query(
      'SELECT billing_schedule_json FROM contracts WHERE CAST(id AS TEXT) = ?',
      id,
    );
    return (result.rows[0] as { billing_schedule_json: unknown })
      .billing_schedule_json;
  };
  return db.transaction ? db.transaction(read) : read(db);
}

/** A NULL schedule saves as no schedule; a schedule change is still refused. */
export async function proveNullBillingScheduleSave(
  db: DatabaseInterface,
): Promise<void> {
  const tenantId = randomUUID();
  const [reviewed, forged, cleared] = await legacyContracts(db, tenantId, 3);
  await withTenant({ tenantId }, async () => {
    const contracts = await ContractCollection.create({ db });
    const load = async (id: string) => {
      const contract = await contracts.get({ id }, { cache: false });
      if (!contract) throw new Error(`Contract ${id} was not found`);
      return contract;
    };

    const legacy = await load(reviewed);
    expect(legacy.billingScheduleJson).toBe('');
    legacy.status = ContractStatus.ACCEPTED;
    await legacy.save();
    expect((await load(reviewed)).status).toBe(ContractStatus.ACCEPTED);
    expect(await storedSchedule(db, reviewed)).toBe('');

    const changed = await load(forged);
    changed.billingScheduleJson = JSON.stringify({ revision: 1 });
    await expect(changed.save()).rejects.toThrow('schedule commands');
    expect(await storedSchedule(db, forged)).toBeNull();

    const nulled = await load(cleared);
    (nulled as { billingScheduleJson: string | null }).billingScheduleJson =
      null;
    nulled.status = ContractStatus.ACCEPTED;
    await nulled.save();
    expect(await storedSchedule(db, cleared)).toBe('');
  });
}

/**
 * `upgradeCommerceMoney` stores `''` for every NULL schedule, once.
 * `beforeUpgrade` runs after the fixtures are written (e.g. to force row
 * policies the upgrade must see past).
 */
export async function proveNullBillingScheduleBackfill(
  db: DatabaseInterface,
  beforeUpgrade?: () => Promise<void>,
): Promise<void> {
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const ids = await legacyContracts(db, tenantId, 2);
  const [other] = await legacyContracts(db, otherTenantId, 1);
  await beforeUpgrade?.();
  const scoped = await upgradeCommerceMoney(db, { tenantId });
  expect(scoped.billingSchedulesBackfilled).toBe(2);
  for (const id of ids) expect(await storedSchedule(db, id)).toBe('');
  expect(await storedSchedule(db, other)).toBeNull();
  expect(
    (await upgradeCommerceMoney(db, { tenantId })).billingSchedulesBackfilled,
  ).toBe(0);
  const all = await upgradeCommerceMoney(db);
  expect(all.billingSchedulesBackfilled).toBeGreaterThanOrEqual(1);
  expect(await storedSchedule(db, other)).toBe('');
}
