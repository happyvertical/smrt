import {
  getTestDatabase,
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
class $M3ResourceIdentity extends SmrtObject {
  static performAnExtremelyLongApplicationWorkflowWithExplicitAuthorization() {
    return { source: 'real-canonical-target' };
  }
}

class ResourceIdentityCollection extends SmrtCollection<$M3ResourceIdentity> {
  static readonly _itemClass = $M3ResourceIdentity;
}
let db: Awaited<ReturnType<typeof getTestDatabase>>;
beforeAll(async () => {
  ObjectRegistry.registerCollection(
    '$M3ResourceIdentity',
    ResourceIdentityCollection,
  );
  ObjectRegistry.getMethods('$M3ResourceIdentity').set(action, {
    name: action,
    async: false,
    isPublic: true,
    isStatic: true,
    returnType: 'object',
    parameters: [],
  });
  ObjectRegistry.invalidateAllInheritanceCaches();
  db = await getTestDatabase({ classes: ['$M3ResourceIdentity'] });
});
afterAll(async () => {
  await db?.close?.();
});

const base = {
  smrtOptions: () => ({ db }),
  serverInfo: { name: 'identity-integration', version: '1' },
  allowedClassNames: ['$M3ResourceIdentity'],
};
const principal = { id: 'owner', tenantId: 'tenant-a' };
const raw = `$m3resourceidentity_${action.toLowerCase()}`;

const uri = 'ui://canonical/v1/review.html';
const resource = {
  uri,
  name: 'Review',
  version: 'v1',
  html: '<title>Review</title>',
};

describe('resources beside real canonical generated tools', () => {
  it('preserves aliases and checks current resource owner, tenant and associated tool policy on every read', async () => {
    let member = true;
    let toolAllowed = true;
    const app = createMcpAppServer({
      ...base,
      resources: [resource],
      resourcePolicy: ({ principal: caller }) =>
        member &&
        caller?.id === principal.id &&
        caller.tenantId === principal.tenantId,
      toolPolicy: ({ tool }) => tool.name !== 'review_get' || toolAllowed,
      workflowTools: [
        {
          name: 'review_get',
          description: 'Review',
          inputSchema: { type: 'object' },
          effect: 'read',
          idempotent: true,
          openWorld: false,
          ui: { resourceUri: uri, visibility: ['app'] },
          execute: () => ({
            content: [{ type: 'text', text: 'Headless review' }],
          }),
        },
      ],
    });
    const tools = await app.listTools({ principal });
    const generated = tools.find((tool) => tool.name !== 'review_get')!;
    expect(generated.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(generated.name).not.toBe(raw);
    expect(
      (await app.callTool({ name: generated.name, principal })).isError,
    ).not.toBe(true);
    expect(await app.listResources!({ principal })).toHaveLength(1);
    expect((await app.readResource!({ uri, principal })).text).toBe(
      resource.html,
    );
    for (const caller of [
      null,
      { id: 'other', tenantId: 'tenant-a' },
      { id: 'owner', tenantId: 'tenant-b' },
      { id: 'owner' },
    ]) {
      expect(await app.listResources!({ principal: caller })).toEqual([]);
      await expect(
        app.readResource!({ uri, principal: caller }),
      ).rejects.toMatchObject({ status: 404 });
    }
    toolAllowed = false;
    expect(await app.listResources!({ principal })).toEqual([]);
    await expect(app.readResource!({ uri, principal })).rejects.toMatchObject({
      status: 404,
    });
    toolAllowed = true;
    expect(await app.listResources!({ principal })).toHaveLength(1);
    member = false;
    expect(await app.listResources!({ principal })).toEqual([]);
    await expect(app.readResource!({ uri, principal })).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      app.readResource!({ uri: 'ui://canonical/v1/guessed.html', principal }),
    ).rejects.toMatchObject({ status: 404 });
    const noPolicy = createMcpAppServer({ ...base, resources: [resource] });
    expect(await noPolicy.listResources!({ principal })).toEqual([]);
    await expect(
      noPolicy.readResource!({ uri, principal }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
