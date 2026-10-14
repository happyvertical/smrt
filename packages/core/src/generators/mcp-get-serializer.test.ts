import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { field } from '../decorators/index.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { getTestDatabase } from '../testing/database.js';
import {
  getMcpGetSerializerCalls,
  resetMcpGetSerializerCalls,
} from './__tests__/fixtures/mcp-get-serializer.js';
import { MCPGenerator } from './mcp.js';

@smrt({
  mcp: {
    include: ['list', 'get'],
    serializers: {
      get: {
        importPath: './__tests__/fixtures/mcp-get-serializer.js',
        exportName: 'serializeMcpGetFixture',
      },
    },
  },
})
class McpSerializedThing extends SmrtObject {
  @field()
  title = '';

  @field({ sensitive: true })
  secret = '';

  @field({ readPermission: 'things.private.read' })
  permitted = '';
}

describe('MCP get serializers (#3937)', () => {
  let db: Awaited<ReturnType<typeof getTestDatabase>>;

  beforeAll(async () => {
    db = await getTestDatabase({ classes: ['McpSerializedThing'] });
    const item = new McpSerializedThing({
      db,
      id: '00000000-0000-4000-8000-000000003937',
      title: 'Stored title',
      secret: 'never-public',
      permitted: 'permission-scoped',
    });
    await item.initialize();
    await item.save();
    const rejected = new McpSerializedThing({
      db,
      id: '00000000-0000-4000-8000-000000003938',
      title: 'Reject me',
    });
    await rejected.initialize();
    await rejected.save();
  });

  afterAll(async () => {
    await db?.close?.();
  });

  it('awaits get enrichment and preserves public-field projection', async () => {
    resetMcpGetSerializerCalls();
    const response = await new MCPGenerator(
      { classNames: ['McpSerializedThing'] },
      { db, user: { id: 'reader' }, permissions: [] },
    ).handleToolCall({
      method: 'tools/call',
      params: {
        name: 'mcpserializedthing_get',
        arguments: { id: '00000000-0000-4000-8000-000000003937' },
      },
    });

    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({
      title: 'Stored title',
      related: [{ title: 'Stored title' }],
    });
    expect(response.structuredContent).not.toHaveProperty('secret');
    expect(response.structuredContent).not.toHaveProperty('permitted');
    expect(response.structuredContent).not.toHaveProperty('related.0.secret');
    expect(response.structuredContent).not.toHaveProperty(
      'related.0.permitted',
    );
    expect(getMcpGetSerializerCalls()).toBe(1);
  });

  it('does not invoke the get serializer for list or before authentication', async () => {
    resetMcpGetSerializerCalls();
    const authenticated = new MCPGenerator(
      { classNames: ['McpSerializedThing'] },
      { db, user: { id: 'reader' } },
    );
    await authenticated.handleToolCall({
      method: 'tools/call',
      params: { name: 'mcpserializedthing_list', arguments: {} },
    });
    expect(getMcpGetSerializerCalls()).toBe(0);

    const denied = await new MCPGenerator(
      { classNames: ['McpSerializedThing'] },
      { db },
    ).handleToolCall({
      method: 'tools/call',
      params: {
        name: 'mcpserializedthing_get',
        arguments: { id: '00000000-0000-4000-8000-000000003937' },
      },
    });
    expect(denied.isError).toBe(true);
    expect(getMcpGetSerializerCalls()).toBe(0);
  });

  it('passes caller read permissions to the serializer', async () => {
    resetMcpGetSerializerCalls();
    const response = await new MCPGenerator(
      { classNames: ['McpSerializedThing'] },
      {
        db,
        user: { id: 'reader' },
        permissions: ['things.private.read'],
      },
    ).handleToolCall({
      method: 'tools/call',
      params: {
        name: 'mcpserializedthing_get',
        arguments: { id: '00000000-0000-4000-8000-000000003937' },
      },
    });
    expect(response.structuredContent).toMatchObject({
      permitted: 'permission-scoped',
    });
    expect(response.structuredContent).not.toHaveProperty('secret');
  });

  it('preserves explicitly public serializer error codes', async () => {
    const response = await new MCPGenerator(
      { classNames: ['McpSerializedThing'] },
      { db, user: { id: 'reader' } },
    ).handleToolCall({
      method: 'tools/call',
      params: {
        name: 'mcpserializedthing_get',
        arguments: { id: '00000000-0000-4000-8000-000000003938' },
      },
    });
    expect(response).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: 'FROZEN_DOCUMENT',
          message: 'Tenant money migration is in progress',
        },
      },
    });
  });
});
