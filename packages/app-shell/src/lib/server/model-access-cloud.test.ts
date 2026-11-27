// Grants are cleared per tenant: one tenant removing a model never touches
// another tenant's grants (cloud profile, tenancy interceptor on).
import {
  DEFAULT_ROLE_SLUGS,
  MembershipCollection,
  MembershipStatus,
  RoleCollection,
} from '@happyvertical/smrt-users';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { AppDefinition, VersionRecord } from '../../engine/index.ts';
import {
  ModelAccessGrant,
  ModelAccessGrantCollection,
} from '../objects/ModelAccessGrant.ts';
import { type CloudHarness, openCloudShell } from './cloud-test-support.ts';
import { runAs, staffPrincipalFor } from './owner.ts';
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

const asStore = (who: typeof h.a) => new ShellVersionStore(h.db, who.tenantId);
const install = (
  who: typeof h.a,
  version: number,
  d: AppDefinition,
  parent: number | null = null,
) =>
  runAs(who, () =>
    asStore(who)
      .commit([record(version, d)], version)
      .then(() => parent),
  );
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

it("removing a model clears that tenant's grants only", async () => {
  const withChore = def('Chore');
  await install(h.a, 0, withChore);
  await install(h.b, 0, withChore);
  await runAs(h.a, () => ModelAccessGrant.grant('Chore', 'read'));
  await runAs(h.b, () => ModelAccessGrant.grant('Chore', 'read'));
  await runAs(h.a, () => asStore(h.a).commit([record(1, def())], 1));
  expect(await count(h.a)).toBe(0);
  expect(await count(h.b)).toBe(1);
});

it("tenant B's staff get nothing from tenant A's grants; list shows own only", async () => {
  const d = def('Widget');
  await runAs(h.a, () => asStore(h.a).commit([record(2, d)], 2));
  await runAs(h.b, () => asStore(h.b).commit([record(3, d)], 3));
  await runAs(h.a, () => ModelAccessGrant.grant('Widget', 'update'));
  const roles = await RoleCollection.create({ db: h.db });
  await roles.seedSystemRoles({ seedPermissions: false });
  const role = await roles.findSystemRoleBySlug(DEFAULT_ROLE_SLUGS.MEMBER);
  const user = await h.newUser('staffb@example.test');
  const m = await (await MembershipCollection.create({ db: h.db })).create({
    userId: user.id,
    tenantId: h.b.tenantId,
    roleId: role?.id as string,
    status: MembershipStatus.ACTIVE,
  });
  await m.save();
  const staffB = { id: user.id, tenantId: h.b.tenantId };
  expect(
    (await staffPrincipalFor(staffB, h.b.tenantId, d)).permissions,
  ).toEqual([]);
  // B's own grant opens only B's slugs for B's staff
  await runAs(h.b, () => ModelAccessGrant.grant('Widget', 'read'));
  expect(
    (await staffPrincipalFor(staffB, h.b.tenantId, d)).permissions.toSorted(),
  ).toEqual(['u_widgets.count', 'u_widgets.get', 'u_widgets.list']);
  expect(await runAs(h.a, () => ModelAccessGrant.list())).toEqual([
    expect.objectContaining({ model: 'Widget', action: 'update' }),
  ]);
});
