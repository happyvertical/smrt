// The method-code entitlement in a running cloud shell (#5194, #5597), end to
// end on SQLite with the real stores: smrt-features' resolver and
// smrt-subscriptions' plans and subscriptions. One tenant's plan grants
// `app.methods`, the other has no plan. The desktop passes no gate and is
// never asked. NOT exercised: PostgreSQL (plan reads are tenant-scoped there).
import {
  FEATURE_APP_METHODS,
  FEATURE_INFERENCE_HOSTED,
} from '@happyvertical/smrt-features';
import {
  SubscriptionPlanCollection,
  TenantSubscriptionCollection,
} from '@happyvertical/smrt-subscriptions';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { METHOD_CODE_DENIED } from '../../engine/index.ts';
import { hostOwner } from '../../test/engine-principal.ts';
import { type CloudHarness, openCloudShell } from './cloud-test-support.ts';
import { getHost } from './host.ts';
import {
  installMethodCodeGate,
  isMethodCodeEntitled,
  resetMethodCodeGate,
} from './method-code.ts';
import { runAs } from './owner.ts';
import { openShell, type ShellHarness } from './test-support.ts';

let cloud: CloudHarness | null = null;
let local: ShellHarness | null = null;
afterEach(async () => {
  resetMethodCodeGate();
  await cloud?.close();
  await local?.close();
  cloud = null;
  local = null;
});

const METHOD = {
  description: 'add a row',
  code: `app.create('Chore', { title: 'by code' }); return 1;`,
};

async function subscribe(
  h: CloudHarness,
  tenantId: string,
  features: string[],
) {
  const plans = await SubscriptionPlanCollection.create({ db: h.db });
  const plan = await plans.create({
    planKey: `plan-${features.join('-')}`,
    name: 'Plan',
    tenantId: null,
  });
  plan.setFeatureGrants(features);
  await plan.save();
  await withTenant({ tenantId }, async () => {
    const subs = await TenantSubscriptionCollection.create({ db: h.db });
    const sub = await subs.create({
      tenantId,
      planId: String(plan.id),
      status: 'active',
    });
    await sub.save();
  });
}

async function openCloud() {
  cloud = await openCloudShell({ methodCode: isMethodCodeEntitled });
  const h = cloud;
  await installMethodCodeGate({ db: async () => h.db });
  return h;
}

/** The tenant's live host with a Chore model (a formula and, when allowed, a method). */
async function app(o: CloudHarness['a'], withMethod: boolean) {
  const host = await runAs(o, () => getHost());
  // The owner holds the slugs of the CURRENT definition: read it per call.
  const run = (cmd: Parameters<typeof host.execute>[1]) =>
    host.execute(hostOwner(host), cmd, { author: 't', approved: true });
  await run({
    type: 'defineModel',
    name: 'Chore',
    fields: { title: { type: 'text' }, qty: { type: 'integer' } },
  });
  await run({
    type: 'addField',
    model: 'Chore',
    field: 'double',
    definition: {
      type: 'integer',
      calculated: { op: 'mul', left: { col: 'qty' }, right: { value: 2 } },
    },
  } as never);
  if (withMethod)
    await run({
      type: 'addMethod',
      model: 'Chore',
      name: 'go',
      method: METHOD,
    });
  return {
    host,
    get owner() {
      return hostOwner(host);
    },
    run,
  };
}

describe('method code in the cloud shell', () => {
  it('a tenant whose plan grants app.methods adds and runs method code', async () => {
    const h = await openCloud();
    await subscribe(h, h.a.tenantId, [FEATURE_APP_METHODS]);
    const { host, owner } = await app(h.a, true);
    expect((await host.runMethod(owner, 'Chore', 'go')).result).toBe(1);
    expect(await host.list(owner, 'Chore')).toHaveLength(1);
  });

  it('a tenant without the key cannot add or run it, but formulas work', async () => {
    const h = await openCloud();
    await subscribe(h, h.a.tenantId, [FEATURE_APP_METHODS]);
    const withKey = await app(h.a, true);
    expect(withKey.host.def.models.Chore.methods?.go).toBeDefined();
    // Bob has no plan; a plan with only another key does not grant it either.
    const bob = await app(h.b, false);
    await expect(
      bob.run({
        type: 'addMethod',
        model: 'Chore',
        name: 'go',
        method: METHOD,
      }),
    ).rejects.toMatchObject({ details: { code: METHOD_CODE_DENIED } });
    const row = await bob.host.create(bob.owner, 'Chore', {
      title: 'x',
      qty: 5,
    });
    expect(row.double).toBe(10);
  });

  it('a plan that grants only another key does not grant it', async () => {
    const h = await openCloud();
    await subscribe(h, h.b.tenantId, [FEATURE_INFERENCE_HOSTED]);
    const bob = await app(h.b, false);
    await expect(
      bob.run({
        type: 'addMethod',
        model: 'Chore',
        name: 'go',
        method: METHOD,
      }),
    ).rejects.toMatchObject({ details: { code: METHOD_CODE_DENIED } });
  });

  it('fails closed when the check was never installed', async () => {
    cloud = await openCloudShell({ methodCode: isMethodCodeEntitled });
    const { run } = await app(cloud.a, false);
    await expect(
      run({ type: 'addMethod', model: 'Chore', name: 'go', method: METHOD }),
    ).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('the desktop', () => {
  it('passes no gate, never asks, and runs method code', async () => {
    const asked = vi.fn(async () => false);
    local = await openShell({ methodCode: asked });
    const host = await runAs(local.owner, () => getHost());
    await host.execute(
      hostOwner(host),
      {
        type: 'defineModel',
        name: 'Chore',
        fields: { title: { type: 'text' } },
      },
      { author: 't', approved: true },
    );
    await host.execute(
      hostOwner(host),
      { type: 'addMethod', model: 'Chore', name: 'go', method: METHOD },
      { author: 't', approved: true },
    );
    expect((await host.runMethod(hostOwner(host), 'Chore', 'go')).result).toBe(
      1,
    );
    expect(asked).not.toHaveBeenCalled();
    // The desktop never builds the check either.
    await installMethodCodeGate({ db: async () => local as never });
    await expect(isMethodCodeEntitled('t')).rejects.toThrow(/not installed/);
  });
});
