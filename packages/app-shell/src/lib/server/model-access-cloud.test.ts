// Grants are cleared per tenant: one tenant removing a model never touches
// another tenant's grants (cloud profile, tenancy interceptor on).
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { AppDefinition, VersionRecord } from '../../engine/index.ts';
import {
  ModelAccessGrant,
  ModelAccessGrantCollection,
} from '../objects/ModelAccessGrant.ts';
import { type CloudHarness, openCloudShell } from './cloud-test-support.ts';
import { runAs } from './owner.ts';
import { ShellVersionStore } from './version-store.ts';

let h: CloudHarness;
beforeAll(async () => {
  h = await openCloudShell();
});
afterAll(async () => {
  await h.close();
});

const def = (...models: string[]) =>
  ({
    format: 1,
    name: 'My app',
    recipes: [],
    models: Object.fromEntries(models.map((m) => [m, { fields: {} }])),
  }) as unknown as AppDefinition;
const record = (version: number, d: AppDefinition): VersionRecord => ({
  version,
  parent: version === 0 ? null : version - 1,
  author: 'test',
  summary: `v${version}`,
  definition: d,
  migration: null,
  createdAt: new Date().toISOString(),
});

it("removing a model clears that tenant's grants only", async () => {
  const withChore = def('Chore');
  const storeA = new ShellVersionStore(h.db, h.a.tenantId);
  await runAs(h.a, () => storeA.commit([record(0, withChore)], 0));
  await runAs(h.a, () => ModelAccessGrant.grant(withChore, 'Chore', 'read'));
  await runAs(h.b, () => ModelAccessGrant.grant(withChore, 'Chore', 'read'));
  await runAs(h.a, () => storeA.commit([record(1, def())], 1));
  const count = async (who: typeof h.a) =>
    (
      await runAs(who, async () =>
        (
          await ModelAccessGrantCollection.create({ db: h.db })
        ).list({
          limit: 100,
        }),
      )
    ).length;
  expect(await count(h.a)).toBe(0);
  expect(await count(h.b)).toBe(1);
});
