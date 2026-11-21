/**
 * A request keeps the tenancy it was admitted under: a registration that
 * changes the model's policy between admission and the first query refuses
 * that request, and the next request is served under the new policy.
 *
 * Row 9 of the #5375 test-design contract.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  field,
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { APIGenerator } from '@happyvertical/smrt-core/generators/rest';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { withSystemContext } from '../context.js';
import { disableTenancy, enableTenancy } from '../interceptor.js';
import {
  registerTenantScopedClass,
  unregisterTenantScopedClass,
} from '../registry.js';
import {
  keyOf,
  restCall,
  segmentOf,
  TENANT_A,
  TENANT_B,
} from './helpers/effective-tenancy-harness.js';

/** A pause the test releases: the action waits on it before it reads. */
let pause: { reached: () => void; release: Promise<void> } | undefined;

@smrt({
  api: {
    include: ['list', 'pausedCount'],
    routes: { pausedCount: { method: 'GET', path: 'paused-count' } },
  },
})
class EffGauge extends SmrtObject {
  @field({ type: 'text' }) title = '';
  @field({ type: 'text', nullable: true }) tenantId: string | null = null;
  @field({ type: 'text', nullable: true }) organizationId: string | null = null;
}
class EffGaugeCollection extends SmrtCollection<EffGauge> {
  static readonly _itemClass = EffGauge;
  async pausedCount(_options?: unknown) {
    if (pause) {
      pause.reached();
      await pause.release;
    }
    return (await this.list({})).length;
  }
}

const SESSIONS: Record<string, { tenantId?: string }> = {
  'user-of-a': { tenantId: TENANT_A },
};
const tokenOf = (req: Request) =>
  (req.headers.get('authorization') ?? '').replace('Bearer ', '');

describe('a request keeps the tenancy it was admitted under', () => {
  let dir: string;
  let db: DatabaseInterface;
  let handler: (req: Request) => Promise<Response>;
  let key = '';

  beforeAll(async () => {
    ObjectRegistry.registerCollection('EffGauge', EffGaugeCollection as never);
    key = keyOf(EffGauge);
    // A loaded manifest records a collection-hosted action's parameters under
    // the collection class, which is registered for them.
    ObjectRegistry.register(EffGaugeCollection as never, {});
    // Registration introspects the prototype; keep only what a manifest names.
    ObjectRegistry.getMethods('EffGaugeCollection').clear();
    ObjectRegistry.getMethods('EffGaugeCollection').set('pausedCount', {
      name: 'pausedCount',
      parameters: [{ name: 'options', type: 'any', optional: true }],
      returnType: 'Promise<any>',
      isPublic: true,
    } as never);
    dir = mkdtempSync(join(tmpdir(), 'smrt-effective-binding-'));
    db = await getTestDatabase({
      type: 'sqlite',
      url: join(dir, 'app.db'),
      classes: [key],
    });
    const gauges = await EffGaugeCollection.create({ db });
    enableTenancy();
    await withSystemContext(async () => {
      await gauges.create({
        title: 'ours',
        tenantId: TENANT_A,
        organizationId: TENANT_B,
      } as never);
      await gauges.create({ title: 'everyone' } as never);
      await gauges.create({
        title: 'theirs',
        tenantId: TENANT_B,
        organizationId: TENANT_A,
      } as never);
    });
    handler = new APIGenerator(
      {
        basePath: '/api',
        authMiddleware: () => async (req: Request) => req,
        resolveTenant: (req: Request) => {
          const session = SESSIONS[tokenOf(req)];
          return session
            ? { ...session, authenticated: true }
            : { authenticated: false };
        },
      },
      { db },
    ).generateHandler();
  }, 60_000);

  afterEach(() => {
    pause = undefined;
    unregisterTenantScopedClass(key);
  });

  afterAll(async () => {
    disableTenancy();
    await db?.close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Start a request, change the policy once it is admitted, then let it read. */
  const servedAcrossAChange = async (
    headers: Record<string, string>,
    change: () => void,
  ) => {
    let reached!: () => void;
    const admitted = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    pause = {
      reached,
      release: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    const pending = restCall(
      handler,
      'GET',
      `${segmentOf(EffGauge)}/paused-count`,
      {
        headers,
      },
    );
    // The request must reach the action body; one answered before it fails
    // here instead of waiting on a pause it never reaches.
    const first = await Promise.race([
      admitted.then(() => 'admitted' as const),
      pending.then(() => 'answered' as const),
    ]);
    expect(first).toBe('admitted');
    change();
    release();
    const answer = await pending;
    pause = undefined;
    return answer;
  };

  it('a policy change between admission and the first query refuses that request with 403; the next request uses the new policy', async () => {
    // Unregistration while tenant A's request is in flight. A caller with no
    // tenant never reaches the action while the model is scoped: runtime
    // REST refuses it every custom collection action (#5164).
    registerTenantScopedClass(key, { mode: 'optional' });
    expect(
      (await restCall(handler, 'GET', `${segmentOf(EffGauge)}/paused-count`))
        .status,
    ).toBe(401);
    const dropped = await servedAcrossAChange(
      { authorization: 'Bearer user-of-a' },
      () => unregisterTenantScopedClass(key),
    );
    expect(dropped.status).toBe(403);
    const afterDrop = await restCall(
      handler,
      'GET',
      `${segmentOf(EffGauge)}/paused-count`,
    );
    expect(afterDrop.status).toBe(200);
    expect((afterDrop.body as { result: unknown }).result).toBe(3);

    // An ownership field change while tenant A's request is in flight.
    registerTenantScopedClass(key, { mode: 'optional' });
    const moved = await servedAcrossAChange(
      { authorization: 'Bearer user-of-a' },
      () =>
        registerTenantScopedClass(key, {
          mode: 'optional',
          field: 'organizationId',
        }),
    );
    expect(moved.status).toBe(403);
    const afterMove = await restCall(
      handler,
      'GET',
      `${segmentOf(EffGauge)}/paused-count`,
      { headers: { authorization: 'Bearer user-of-a' } },
    );
    expect(afterMove.status).toBe(200);
    expect((afterMove.body as { result: unknown }).result).toBe(1);
  });
});
