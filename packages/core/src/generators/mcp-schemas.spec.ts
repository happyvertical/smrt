/**
 * Coverage for MCP generator tool input-schemas and metadata (#1500).
 *
 * The existing mcp-protocol/integration/examples suites cover tool dispatch and
 * server-code generation. This file asserts the produced tool *input schemas*
 * for every field type (the fieldToMCPSchema branches), the create/update tool
 * shapes (properties + required), the server-info/getter accessors, and the
 * `public` / `public: 'read'` tool-auth branches that let unauthenticated reads
 * and writes through.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SmrtCollection } from '../collection';
import { field } from '../decorators';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { getTestDatabase } from '../testing/database';
import { MCPGenerator } from './mcp';

// One field of each supported type so every fieldToMCPSchema branch is hit.
@smrt({ mcp: { include: ['list', 'get', 'create', 'update', 'delete'] } })
class McpSchemaWidget extends SmrtObject {
  @field({ type: 'text', required: true, maxLength: 50, minLength: 3 })
  title = '';

  @field({ type: 'integer', min: 0, max: 10, default: 1 })
  count = 0;

  @field({ type: 'decimal', min: 0.5, max: 99.5 })
  rating = 0.0;

  @field({ type: 'boolean' })
  active = false;

  @field({ type: 'datetime', nullable: true })
  startsAt: string | null = null;

  @field({ type: 'json' })
  payload: Record<string, any> = {};

  constructor(options: any = {}) {
    super(options);
    const { db, ai, fs, ...safe } = options;
    Object.assign(this, safe);
  }
}

class McpSchemaWidgetCollection extends SmrtCollection<McpSchemaWidget> {
  static readonly _itemClass = McpSchemaWidget;
}

describe('MCP tool input schemas (#1500)', () => {
  ObjectRegistry.registerCollection(
    'McpSchemaWidget',
    McpSchemaWidgetCollection,
  );

  let tools: Awaited<ReturnType<MCPGenerator['generateTools']>>;

  beforeAll(async () => {
    const generator = new MCPGenerator();
    tools = await generator.generateTools();
  });

  const tool = (name: string) => tools.find((t) => t.name === name);

  it('emits the five CRUD tools for the object', () => {
    for (const verb of ['list', 'get', 'create', 'update', 'delete']) {
      expect(tool(`mcpschemawidget_${verb}`)).toBeDefined();
    }
  });

  it('builds the list tool with pagination + where properties', () => {
    const list = tool('mcpschemawidget_list');
    const props = list?.inputSchema.properties as Record<string, any>;
    expect(props.limit.type).toBe('integer');
    expect(props.limit.default).toBe(50);
    expect(props.offset.type).toBe('integer');
    expect(props.orderBy.type).toBe('string');
    expect(props.where.additionalProperties).toBe(true);
  });

  it('marks id (not slug) as required on the get tool', () => {
    const get = tool('mcpschemawidget_get');
    expect(get?.inputSchema.required).toEqual(['id']);
    const props = get?.inputSchema.properties as Record<string, any>;
    expect(props.id.type).toBe('string');
    expect(props.slug.type).toBe('string');
  });

  it('maps every field type in the create tool schema', () => {
    const create = tool('mcpschemawidget_create');
    const props = create?.inputSchema.properties as Record<string, any>;

    // text with length constraints
    expect(props.title.type).toBe('string');
    expect(props.title.maxLength).toBe(50);
    expect(props.title.minLength).toBe(3);

    // integer with min/max + default
    expect(props.count.type).toBe('integer');
    expect(props.count.minimum).toBe(0);
    expect(props.count.maximum).toBe(10);
    expect(props.count.default).toBe(1);

    // decimal → number with min/max
    expect(props.rating.type).toBe('number');
    expect(props.rating.minimum).toBe(0.5);
    expect(props.rating.maximum).toBe(99.5);

    // boolean
    expect(props.active.type).toBe('boolean');

    // datetime → string/date-time
    expect(props.startsAt.type).toBe('string');
    expect(props.startsAt.format).toBe('date-time');

    // json → object
    expect(props.payload.type).toBe('object');

    // required-field propagation onto the create schema.
    expect(create?.inputSchema.required).toContain('title');
  });

  it('includes id plus all fields on the update tool, requiring id', () => {
    const update = tool('mcpschemawidget_update');
    const props = update?.inputSchema.properties as Record<string, any>;
    expect(props.id.type).toBe('string');
    expect(props.title).toBeDefined();
    expect(props.count).toBeDefined();
    expect(update?.inputSchema.required).toEqual(['id']);
  });

  it('requires id on the delete tool', () => {
    const del = tool('mcpschemawidget_delete');
    expect(del?.inputSchema.required).toEqual(['id']);
  });
});

// foreignKey field is split out so its `ID of related ...` description renders.
@smrt({ mcp: { include: ['create'] } })
class McpFkWidget extends SmrtObject {
  @field({ type: 'foreignKey', related: 'Author' })
  authorId = '';

  constructor(options: any = {}) {
    super(options);
    const { db, ai, fs, ...safe } = options;
    Object.assign(this, safe);
  }
}

describe('MCP foreignKey field schema (#1500)', () => {
  it('renders a foreignKey field as a string with a related-id description', async () => {
    const generator = new MCPGenerator();
    const tools = await generator.generateTools();
    const create = tools.find((t) => t.name === 'mcpfkwidget_create');
    const props = create?.inputSchema.properties as Record<string, any>;
    expect(props.authorId.type).toBe('string');
    expect(props.authorId.description).toContain('ID of related');
  });
});

describe('MCP generator metadata accessors (#1500)', () => {
  it('exposes name/version getters and a default server info', () => {
    const generator = new MCPGenerator({
      name: 'meta-server',
      version: '2.3.4',
      description: 'a description',
    });
    expect(generator.name).toBe('meta-server');
    expect(generator.version).toBe('2.3.4');

    const info = generator.getServerInfo();
    // server.* defaults are filled in by the constructor.
    expect(info.name).toBe('smrt-mcp');
    expect(info.version).toBe('1.0.0');
    expect(info.description).toBe('a description');
  });

  it('uses the configured server.name/version in server info', () => {
    const generator = new MCPGenerator({
      server: { name: 'custom-srv', version: '7.0.0' },
    });
    const info = generator.getServerInfo();
    expect(info.name).toBe('custom-srv');
    expect(info.version).toBe('7.0.0');
  });
});

// public:true and public:'read' objects to cover requireToolAuth allow-paths
// without an authenticated context.
@smrt({ mcp: { include: ['list', 'get', 'create'] }, api: { public: true } })
class McpPublicWidget extends SmrtObject {
  @field({ type: 'text' })
  name = '';

  constructor(options: any = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
  }
}

class McpPublicWidgetCollection extends SmrtCollection<McpPublicWidget> {
  static readonly _itemClass = McpPublicWidget;
}

@smrt({
  mcp: { include: ['list', 'get', 'create'] },
  api: { public: 'read' },
})
class McpReadPublicWidget extends SmrtObject {
  @field({ type: 'text' })
  name = '';

  constructor(options: any = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
  }
}

class McpReadPublicWidgetCollection extends SmrtCollection<McpReadPublicWidget> {
  static readonly _itemClass = McpReadPublicWidget;
}

describe('MCP tool-auth public branches (#1540)', () => {
  ObjectRegistry.registerCollection(
    'McpPublicWidget',
    McpPublicWidgetCollection,
  );
  ObjectRegistry.registerCollection(
    'McpReadPublicWidget',
    McpReadPublicWidgetCollection,
  );

  let db: any;

  beforeAll(async () => {
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['McpPublicWidget', 'McpReadPublicWidget'],
    });
  });

  afterAll(async () => {
    await db?.close?.();
  });

  it('public:true lets an unauthenticated create through', async () => {
    // No context.user — requireToolAuth must allow because public === true.
    const generator = new MCPGenerator({}, { db });
    const res = await generator.handleToolCall({
      method: 'tools/call',
      params: {
        name: 'mcppublicwidget_create',
        arguments: { name: 'PublicCreated' },
      },
    });
    const payload = JSON.parse(res.content[0].text);
    expect(payload.name).toBe('PublicCreated');
  });

  it("public:'read' allows an unauthenticated list but blocks create", async () => {
    const generator = new MCPGenerator({}, { db });

    const listRes = await generator.handleToolCall({
      method: 'tools/call',
      params: { name: 'mcpreadpublicwidget_list', arguments: {} },
    });
    // A successful list returns a data/meta envelope, not an error string.
    expect(listRes.content[0].text).toContain('"data"');

    const createRes = await generator.handleToolCall({
      method: 'tools/call',
      params: {
        name: 'mcpreadpublicwidget_create',
        arguments: { name: 'nope' },
      },
    });
    // Mutating tool with no principal on a read-only-public object fails closed.
    expect(createRes.content[0].text).toContain('Authentication required');
  });
});
