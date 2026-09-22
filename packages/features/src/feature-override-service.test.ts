import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FeatureOverrideAuthorizationError,
  FeatureOverrideService,
  type FeatureOverrideWriteRequest,
} from './feature-override-service.js';
import { FeatureOverrideCollection } from './feature-overrides.js';
import { FeatureOverrideEffect } from './types.js';

const KEY = '@test/pkg:Demo#newEditor';

describe('FeatureOverrideService (#3013)', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  async function setup() {
    const db = await getTestDatabase({ classes: ['FeatureOverride'] });
    closers.push(async () => {
      if (typeof (db as any).close === 'function') await (db as any).close();
    });
    return (await (FeatureOverrideCollection as any).create({
      db,
    })) as FeatureOverrideCollection;
  }

  it('asks the authorizer and denies writes to any other scope', async () => {
    const overrides = await setup();
    const seen: FeatureOverrideWriteRequest[] = [];
    const service = new FeatureOverrideService(overrides, (request) => {
      seen.push(request);
      return request.scopeType === 'tenant' && request.scopeId === 'tenant-1';
    });

    await service.setOverride(
      KEY,
      'tenant',
      'tenant-1',
      FeatureOverrideEffect.ENABLE,
    );
    await expect(
      service.setOverride(
        KEY,
        'tenant',
        'tenant-2',
        FeatureOverrideEffect.DISABLE,
      ),
    ).rejects.toBeInstanceOf(FeatureOverrideAuthorizationError);
    await expect(
      service.setOverride(
        KEY,
        'global',
        'global',
        FeatureOverrideEffect.DISABLE,
      ),
    ).rejects.toMatchObject({ status: 403 });

    expect(seen[0]).toEqual({
      operation: 'set',
      featureKey: KEY,
      scopeType: 'tenant',
      scopeId: 'tenant-1',
      effect: FeatureOverrideEffect.ENABLE,
    });
    expect(
      await overrides.findByFeatureAndScope(KEY, 'tenant', 'tenant-1'),
    ).not.toBeNull();
    expect(
      await overrides.findByFeatureAndScope(KEY, 'tenant', 'tenant-2'),
    ).toBeNull();
    expect(await overrides.getGlobalOverride(KEY)).toBeNull();
  });

  it('denies removal without authorization and keeps the row', async () => {
    const overrides = await setup();
    await overrides.setOverride(
      KEY,
      'tenant',
      'tenant-2',
      FeatureOverrideEffect.ENABLE,
    );
    const service = new FeatureOverrideService(
      overrides,
      (request) => request.scopeId === 'tenant-1',
    );
    await expect(
      service.removeOverride(KEY, 'tenant', 'tenant-2'),
    ).rejects.toBeInstanceOf(FeatureOverrideAuthorizationError);
    expect(
      await overrides.findByFeatureAndScope(KEY, 'tenant', 'tenant-2'),
    ).not.toBeNull();
  });

  it('fails closed on a non-true decision or a throwing authorizer', async () => {
    const overrides = await setup();
    for (const authorize of [
      () => 'yes' as unknown as boolean,
      async () => undefined as unknown as boolean,
      () => {
        throw new Error('authz backend down');
      },
    ]) {
      const service = new FeatureOverrideService(overrides, authorize);
      await expect(
        service.setOverride(
          KEY,
          'tenant',
          'tenant-1',
          FeatureOverrideEffect.ENABLE,
        ),
      ).rejects.toBeInstanceOf(FeatureOverrideAuthorizationError);
    }
    expect(
      await overrides.findByFeatureAndScope(KEY, 'tenant', 'tenant-1'),
    ).toBeNull();
  });
});
