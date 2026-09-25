import {
  APIGenerator,
  getTestDatabase,
  MCPGenerator,
} from '@happyvertical/smrt-core';
import { afterEach, describe, expect, it } from 'vitest';
import { CLIGenerator } from '../../cli/src/cli-generator.js';
import { PromptOverrideCollection } from './collections/PromptOverrideCollection.js';
import { definePrompt, PromptRegistry } from './prompt-registry.js';

// Generated REST routes are fail-closed (#1540). This test exercises CRUD
// verb exposure, not auth, so it simulates an authenticated gateway with a
// pass-through auth middleware. Auth itself is covered by smrt-core tests.
const passThroughAuth =
  () =>
  async (req: Request): Promise<Request | Response> =>
    req;

describe('smrt-prompts generated surfaces', () => {
  const closers = new Set<() => Promise<void>>();

  afterEach(async () => {
    for (const close of closers) {
      await close();
    }
    closers.clear();
    PromptRegistry.clear();
  });

  it('closes generated REST, CLI, and MCP surfaces for PromptOverride (mirrors #3013)', async () => {
    definePrompt({
      key: '@test/pkg:Demo#greeting',
      template: 'Hello, default.',
      editable: { template: true },
    });

    const db = await getTestDatabase({ classes: ['PromptOverride'] });
    closers.add(async () => {
      if (typeof (db as any).close === 'function') {
        await (db as any).close();
      }
    });

    const overrides = await PromptOverrideCollection.create({ db });
    const override = await overrides.create({
      key: '@test/pkg:Demo#greeting',
      tenantId: 'tenant-1',
      template: 'Hello, tenant one.',
    });
    await override.save();

    const api = new APIGenerator({ authMiddleware: passThroughAuth }, { db });
    api.registerCollection('promptoverride', overrides);
    const handler = api.generateHandler();

    const listOverrides = await handler(
      new Request('http://localhost/api/v1/promptoverride'),
    );
    const getOverride = await handler(
      new Request(`http://localhost/api/v1/promptoverride/${override.id}`),
    );
    const createOverride = await handler(
      new Request('http://localhost/api/v1/promptoverride', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          key: '@test/pkg:Demo#greeting',
          tenantId: 'tenant-2',
          template: 'Attacker-supplied text.',
        }),
      }),
    );
    const deleteOverride = await handler(
      new Request(`http://localhost/api/v1/promptoverride/${override.id}`, {
        method: 'DELETE',
      }),
    );

    // No path may read or write PromptOverride through generated REST (#3013).
    for (const response of [
      listOverrides,
      getOverride,
      createOverride,
      deleteOverride,
    ]) {
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect([200, 201, 204]).not.toContain(response.status);
    }
    // No cross-tenant override row was written or removed.
    expect(
      await overrides.getTenantOverride('@test/pkg:Demo#greeting', 'tenant-2'),
    ).toBeNull();
    expect(await overrides.get(override.id)).not.toBeNull();

    const cli = new CLIGenerator({ prompt: false }, { db });
    const overrideCommands = await (cli as any).generateObjectCommands(
      'PromptOverride',
      {},
    );
    expect(overrideCommands).toEqual([]);

    const mcp = new MCPGenerator({}, { db });
    const toolNames = (await mcp.generateTools()).map((tool) => tool.name);
    expect(
      toolNames.filter((name) => name.startsWith('promptoverride_')),
    ).toEqual([]);
  });
});
