// The change feed on the cloud profile (#5191): an owner may read the shell's
// tenant-scoped tables only, never the deployment-wide ones.
import '@happyvertical/smrt-features';
import '@happyvertical/smrt-subscriptions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authorizeChangeFeedForOwner } from './change-feed.ts';
import { type CloudHarness, openCloudShell } from './cloud-test-support.ts';
import { hostedOnlyTables } from './schema.ts';
import { openShell, type ShellHarness } from './test-support.ts';

const asLocals = (who: { id: string; tenantId: string }) => ({
  locals: { user: { id: who.id }, tenantId: who.tenantId, permissions: [] },
  tables: undefined,
});

describe('cloud change feed', () => {
  let h: CloudHarness;
  beforeAll(async () => {
    h = await openCloudShell();
  });
  afterAll(() => h.close());

  it('offers an owner the tenant-scoped shell tables and nothing deployment-wide', async () => {
    const tables = await authorizeChangeFeedForOwner(asLocals(h.a));
    expect(tables).toEqual(expect.arrayContaining(['apps', 'approvals']));
    for (const global of [
      '_smrt_inference_overrides',
      'tenants',
      'users',
      'secrets',
    ])
      expect(tables).not.toContain(global);
  });
});

describe('local change feed', () => {
  let h: ShellHarness;
  beforeAll(async () => {
    h = await openShell();
  });
  afterAll(() => h.close());

  it('is unchanged: the owner is offered every registered table', async () => {
    const tables = await authorizeChangeFeedForOwner(asLocals(h.owner));
    expect(tables).toContain('apps');
    expect(tables).toContain('_smrt_inference_overrides');
  });

  it('never offers the hosted-only tables (#5194)', async () => {
    // Registered in this process, as the build manifest does.
    expect(hostedOnlyTables().size).toBeGreaterThan(0);
    const tables = await authorizeChangeFeedForOwner(asLocals(h.owner));
    for (const table of hostedOnlyTables()) expect(tables).not.toContain(table);
  });
});
