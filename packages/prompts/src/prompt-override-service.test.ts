import { getTestDatabase } from '@happyvertical/smrt-core';
import { afterEach, describe, expect, it } from 'vitest';
import { PromptOverrideCollection } from './collections/PromptOverrideCollection.js';
import {
  PromptOverrideAuthorizationError,
  PromptOverrideService,
  type PromptOverrideWriteRequest,
} from './prompt-override-service.js';
import { definePrompt, PromptRegistry } from './prompt-registry.js';

const KEY = '@test/pkg:Demo#greeting';

describe('PromptOverrideService (mirrors #3013)', () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
    PromptRegistry.clear();
  });

  async function setup() {
    definePrompt({
      key: KEY,
      template: 'Hello, default.',
      editable: { template: true },
    });
    const db = await getTestDatabase({ classes: ['PromptOverride'] });
    closers.push(async () => {
      if (typeof (db as any).close === 'function') await (db as any).close();
    });
    return PromptOverrideCollection.create({ db });
  }

  it('asks the authorizer and denies writes to any other scope', async () => {
    const overrides = await setup();
    const seen: PromptOverrideWriteRequest[] = [];
    const service = new PromptOverrideService(overrides, (request) => {
      seen.push(request);
      return request.scopeType === 'tenant' && request.scopeId === 'tenant-1';
    });

    await service.setTemplateOverride(
      KEY,
      'tenant',
      'tenant-1',
      'Hello, tenant one.',
    );
    await expect(
      service.setTemplateOverride(
        KEY,
        'tenant',
        'tenant-2',
        'Attacker-supplied text.',
      ),
    ).rejects.toBeInstanceOf(PromptOverrideAuthorizationError);
    await expect(
      service.setTemplateOverride(KEY, 'app', '__app__', 'App override.'),
    ).rejects.toMatchObject({ status: 403 });

    expect(seen[0]).toEqual({
      operation: 'set',
      key: KEY,
      scopeType: 'tenant',
      scopeId: 'tenant-1',
      template: 'Hello, tenant one.',
    });
    expect(await overrides.getTenantOverride(KEY, 'tenant-1')).not.toBeNull();
    expect(await overrides.getTenantOverride(KEY, 'tenant-2')).toBeNull();
    expect(await overrides.getAppOverride(KEY)).toBeNull();
  });

  it('denies removal without authorization and keeps the row', async () => {
    const overrides = await setup();
    await overrides.setTemplateOverride(
      KEY,
      'tenant',
      'tenant-2',
      'Existing override.',
    );
    const service = new PromptOverrideService(
      overrides,
      (request) => request.scopeId === 'tenant-1',
    );
    await expect(
      service.removeOverride(KEY, 'tenant', 'tenant-2'),
    ).rejects.toBeInstanceOf(PromptOverrideAuthorizationError);
    expect((await overrides.getTenantOverride(KEY, 'tenant-2'))?.template).toBe(
      'Existing override.',
    );
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
      const service = new PromptOverrideService(overrides, authorize);
      await expect(
        service.setTemplateOverride(KEY, 'tenant', 'tenant-1', 'Text.'),
      ).rejects.toBeInstanceOf(PromptOverrideAuthorizationError);
    }
    expect(await overrides.getTenantOverride(KEY, 'tenant-1')).toBeNull();
  });
});
