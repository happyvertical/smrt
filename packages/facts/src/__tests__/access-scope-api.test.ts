import {
  EmbeddingProvider,
  getTestDatabase,
  ObjectRegistry,
} from '@happyvertical/smrt-core';
import { MCPGenerator } from '@happyvertical/smrt-core/generators/mcp';
import { APIGenerator } from '@happyvertical/smrt-core/generators/rest';
import {
  disableTenancy,
  enableTenancy,
  withSystemContext,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FactCollection } from '../facts';

const tenantId = '10000000-0000-4000-8000-000000000001';

describe('Fact accessScope generated write boundary (#3496)', () => {
  let db: DatabaseInterface;
  let facts: FactCollection;
  let rest: (request: Request) => Promise<Response>;
  let mcp: MCPGenerator;
  beforeEach(async () => {
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['Fact', 'FactSource'],
    });
    vi.spyOn(EmbeddingProvider.prototype, 'embed').mockRejectedValue(
      new Error('offline test provider'),
    );
    facts = await FactCollection.create({ db });
    ObjectRegistry.registerCollection('Fact', FactCollection);
    const api = new APIGenerator({
      basePath: '/api/v1',
      authMiddleware: () => async (request) => request,
    });
    api.registerCollection('facts', facts);
    rest = api.generateHandler();
    mcp = new MCPGenerator(
      {},
      { db, user: { id: 'ordinary-editor' }, tenantId },
    );
    enableTenancy();
  });
  afterEach(async () => {
    disableTenancy();
    vi.restoreAllMocks();
    await db.close?.();
  });

  // REST refuses a write that sets or changes the read-only scope (#5195);
  // an unchanged scope is accepted, so a fetched fact can be sent back.
  it('REST create refuses a forged scope and accepts ordinary writable fields', async () => {
    await withTenant({ tenantId }, async () => {
      const post = (body: Record<string, unknown>) =>
        rest(
          new Request('http://local/api/v1/facts', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
        );
      const refused = await post({
        textRefined: 'REST assertion',
        accessScope: 'private',
      });
      expect(refused.status).toBe(400);
      expect(
        ((await refused.json()) as { error: { details?: unknown } }).error
          .details,
      ).toEqual({ field: 'accessScope' });
      expect(await facts.get({ textRefined: 'REST assertion' })).toBeNull();

      const response = await post({ textRefined: 'REST assertion' });
      expect(response.status).toBe(201);
      const created = await facts.get({ textRefined: 'REST assertion' });
      expect(created?.accessScope).toBeNull();
      expect(created?.tenantId).toBe(tenantId);
    });
  });

  for (const method of ['PUT', 'PATCH']) {
    it(`REST ${method} cannot reclassify a confidential fact`, async () => {
      await withTenant({ tenantId }, async () => {
        const existing = await facts.create({
          textRefined: 'Confidential assertion',
          tenantId,
          accessScope: 'private',
        });
        const send = (accessScope: string) =>
          rest(
            new Request(`http://local/api/v1/facts/${existing.id}`, {
              method,
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ textRaw: 'Allowed edit', accessScope }),
            }),
          );
        const refused = await send('public');
        expect(refused.status).toBe(400);
        expect((await facts.get({ id: existing.id }))?.textRaw).not.toBe(
          'Allowed edit',
        );

        const response = await send('private');
        expect(response.status).toBe(200);
        const updated = await facts.get({ id: existing.id });
        expect(updated?.textRaw).toBe('Allowed edit');
        expect(updated?.accessScope).toBe('private');
      });
    });
  }

  it('MCP create refuses a forged scope but accepts ordinary writable fields', async () => {
    const create = (args: Record<string, unknown>) =>
      mcp.handleToolCall({
        method: 'tools/call',
        params: { name: 'fact_create', arguments: args },
      });
    const refused = await create({
      textRefined: 'MCP forged',
      accessScope: 'private',
    });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused)).toContain('VALIDATION_FIELD_NOT_WRITABLE');
    await withTenant({ tenantId }, async () => {
      expect(await facts.get({ textRefined: 'MCP forged' })).toBeNull();
    });

    // Negative control: without a scope the create is saved with none.
    expect((await create({ textRefined: 'MCP assertion' })).isError).not.toBe(
      true,
    );
    await withTenant({ tenantId }, async () => {
      const created = await facts.get({ textRefined: 'MCP assertion' });
      expect(created).not.toBeNull();
      expect(created?.accessScope).toBeNull();
    });
  });

  it('MCP update refuses to reclassify a confidential fact and accepts the stored scope', async () => {
    await withTenant({ tenantId }, async () => {
      const existing = await facts.create({
        textRefined: 'MCP confidential',
        tenantId,
        accessScope: 'private',
      });
      const update = (args: Record<string, unknown>) =>
        mcp.handleToolCall({
          method: 'tools/call',
          params: {
            name: 'fact_update',
            arguments: { id: existing.id, ...args },
          },
        });
      const refused = await update({
        textRaw: 'Refused MCP edit',
        accessScope: 'public',
      });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused)).toContain(
        'VALIDATION_FIELD_NOT_WRITABLE',
      );
      const unchanged = await facts.get({ id: existing.id });
      expect(unchanged?.textRaw).not.toBe('Refused MCP edit');
      expect(unchanged?.accessScope).toBe('private');

      const response = await update({
        textRaw: 'Allowed MCP edit',
        accessScope: 'private',
      });
      expect(response.isError).not.toBe(true);
      const updated = await facts.get({ id: existing.id });
      expect(updated?.textRaw).toBe('Allowed MCP edit');
      expect(updated?.accessScope).toBe('private');
    });
  });

  it('trusted reconciliation, branching and owner migration retain direct persistence access', async () => {
    await withTenant({ tenantId }, async () => {
      const original = await facts.reconcile({
        rawInput: 'Trusted assertion',
        accessScope: 'private',
      });
      expect(original.fact.accessScope).toBe('private');
      const branch = await facts.branch(original.fact.id as string, {
        textRefined: 'Trusted successor',
        tenantId,
      });
      expect(branch.accessScope).toBe('private');
    });
    // The operator controls this server-side procedure and has stopped writers;
    // no generated endpoint grants access to this migration operation.
    await withSystemContext(async () => {
      const legacy = await facts.create({
        textRefined: 'Classified by owner',
        tenantId,
      });
      legacy.accessScope = 'private';
      await legacy.save();
      expect((await facts.get({ id: legacy.id }))?.accessScope).toBe('private');
    });
  });
});
