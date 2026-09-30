import {
  getTestDatabase,
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMcpAppServer } from '../server.js';

const action =
  'performAnExtremelyLongApplicationWorkflowWithExplicitAuthorization';
@smrt({
  mcp: {
    include: [
      'performAnExtremelyLongApplicationWorkflowWithExplicitAuthorization',
    ],
    tasks: [
      'performAnExtremelyLongApplicationWorkflowWithExplicitAuthorization',
    ],
  },
})
class $M1Identity extends SmrtObject {
  static performAnExtremelyLongApplicationWorkflowWithExplicitAuthorization() {
    return { source: 'real-canonical-target' };
  }
}

class IdentityCollection extends SmrtCollection<$M1Identity> {
  static readonly _itemClass = $M1Identity;
}
let db: Awaited<ReturnType<typeof getTestDatabase>>;
beforeAll(async () => {
  ObjectRegistry.registerCollection('$M1Identity', IdentityCollection);
  ObjectRegistry.getMethods('$M1Identity').set(action, {
    name: action,
    async: false,
    isPublic: true,
    isStatic: true,
    returnType: 'object',
    parameters: [],
  });
  ObjectRegistry.invalidateAllInheritanceCaches();
  db = await getTestDatabase({ classes: ['$M1Identity'] });
});
afterAll(async () => {
  await db?.close?.();
});

const base = {
  smrtOptions: () => ({ db }),
  serverInfo: { name: 'identity-integration', version: '1' },
  allowedClassNames: ['$M1Identity'],
};
const principal = { id: 'owner', tenantId: 'tenant-a' };
const raw = `$m1identity_${action.toLowerCase()}`;

describe('real canonical generator composed with authored workflows', () => {
  it('keeps generator-owned identity, effects and workflow metadata across the app boundary', async () => {
    const app = createMcpAppServer({
      ...base,
      publicToolPatterns: () => ['*'],
      workflowTools: [
        {
          name: 'review_get',
          description: 'Destructive workflow',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          effect: 'destructive',
          idempotent: false,
          openWorld: false,
          ui: { visibility: ['app'] },
          execute: () => ({ content: [] }),
        },
      ],
    });
    const tools = await app.listTools({ principal });
    const generated = tools.find((tool) => tool.name !== 'review_get')!;
    expect(generated.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(generated.name).not.toBe(raw);
    expect(generated.annotations?.readOnlyHint).toBe(false);
    expect(tools.find((tool) => tool.name === 'review_get')).toMatchObject({
      annotations: { readOnlyHint: false, destructiveHint: true },
      _meta: { ui: { visibility: ['app'] } },
    });
    const result = await app.callTool({ name: generated.name, principal });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(JSON.stringify(result)).toContain('real-canonical-target');
    expect(await app.listTools({ principal: null })).toEqual([]);
    await expect(
      app.callTool({ name: 'review_get', principal: null }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      app.callTask({ name: 'review_get', principal }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it.each([
    'callTool',
    'callTask',
  ] as const)('runs alias and original guards before %s dispatch', async (operation) => {
    const [tool] = await createMcpAppServer(base).listTools({ principal });
    const aliasGuard = vi.fn();
    const rawGuard = vi.fn(() => {
      throw new Error('original guard denied');
    });
    const app = createMcpAppServer({
      ...base,
      workflowAssertions: { [tool.name]: aliasGuard, [raw]: rawGuard },
    });
    await expect(
      app[operation]({ name: tool.name, principal }),
    ).rejects.toThrow('original guard denied');
    expect(aliasGuard).toHaveBeenCalledOnce();
    expect(rawGuard).toHaveBeenCalledOnce();
    const denyAlias = createMcpAppServer({
      ...base,
      workflowAssertions: {
        [tool.name]: () => {
          throw new Error('alias guard denied');
        },
      },
    });
    await expect(
      denyAlias[operation]({ name: tool.name, principal }),
    ).rejects.toThrow('alias guard denied');
  });

  it('cannot use canonical aliases to include an excluded original class', async () => {
    const [tool] = await createMcpAppServer(base).listTools({ principal });
    const app = createMcpAppServer({ ...base, allowedClassNames: [] });
    expect(await app.listTools({ principal })).toEqual([]);
    await expect(
      app.callTool({ name: tool.name, principal }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      app.callTask({ name: tool.name, principal }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
