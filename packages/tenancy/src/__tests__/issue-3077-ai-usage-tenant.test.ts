/**
 * #3077: `enableTenancy()` registers the ambient tenant for AI usage
 * attribution, so a per-call client's usage made inside `withTenant()` lands
 * on that tenant; `disableTenancy()` clears it.
 */

import {
  createAiUsageRecorder,
  getAiUsageTenantResolver,
} from '@happyvertical/smrt-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withSystemContext, withTenant } from '../context';
import { disableTenancy, enableTenancy } from '../interceptor';

const event = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  operation: 'chat',
  duration: 1,
  timestamp: new Date(),
};

describe('#3077: ambient tenant for AI usage attribution', () => {
  afterEach(() => {
    disableTenancy();
  });

  it('is registered by enableTenancy() and cleared by disableTenancy()', () => {
    disableTenancy();
    expect(getAiUsageTenantResolver()).toBeUndefined();
    enableTenancy();
    expect(getAiUsageTenantResolver()).toBeTypeOf('function');
    disableTenancy();
    expect(getAiUsageTenantResolver()).toBeUndefined();
  });

  it('attributes usage to the active tenant, never to a system context', async () => {
    enableTenancy();
    const handler = { handle: vi.fn().mockResolvedValue(undefined) };
    const record = createAiUsageRecorder({ usage: { handlers: [handler] } });

    await withTenant({ tenantId: 'tenant-a' }, () => record(event));
    await withTenant({ tenantId: 'tenant-b' }, () =>
      withTenant({ tenantId: 'tenant-c' }, () => record(event)),
    );
    await withSystemContext(() => record(event));
    await record(event);

    expect(handler.handle.mock.calls.map(([e]) => e.tenantId)).toEqual([
      'tenant-a',
      'tenant-c',
      undefined,
      undefined,
    ]);
  });
});
