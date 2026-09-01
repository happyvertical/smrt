/**
 * Tests for MCP generator with custom action support
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SmrtCollection } from '../collection';
import { SmrtObject } from '../object';
import { ObjectRegistry } from '../registry';
import { MCPGenerator } from './mcp';

// Mock decorator function for testing
function smrt(config?: any) {
  return (target: any) => {
    ObjectRegistry.register(target, config);
    return target;
  };
}

// Test class with custom actions
@smrt({
  mcp: {
    include: ['list', 'get', 'research', 'report', 'analyze'],
  },
})
class MCPTestAgent extends SmrtObject {
  name = '';
  source = '';

  constructor(options: any) {
    super(options);
    // Avoid overwriting getter-only properties
    const { db, ai, fs, ...safeOptions } = options;
    Object.assign(this, safeOptions);
  }

  // Custom action methods
  async research(options: any = {}): Promise<any> {
    return {
      action: 'research',
      source: this.source,
      results: options.query
        ? `Research results for: ${options.query}`
        : 'General research complete',
      timestamp: new Date(),
    };
  }

  async report(options: any = {}): Promise<any> {
    return {
      action: 'report',
      type: options.type || 'summary',
      content: `Generated ${options.type || 'summary'} report for ${this.name}`,
      timestamp: new Date(),
    };
  }

  async analyze(options: any = {}): Promise<any> {
    return {
      action: 'analyze',
      analysis: `Analysis of ${this.name}: ${options.criteria || 'general analysis'}`,
      confidence: 0.85,
      timestamp: new Date(),
    };
  }
}

// Test class with invalid custom action (method doesn't exist)
@smrt({
  mcp: {
    include: ['list', 'get', 'nonexistent'],
  },
})
class InvalidActionAgent extends SmrtObject {
  name = '';

  constructor(options: any) {
    super(options);
    // Avoid overwriting getter-only properties
    const { db, ai, fs, ...safeOptions } = options;
    Object.assign(this, safeOptions);
  }
}

// Test class with excluded custom actions
@smrt({
  mcp: {
    include: ['list', 'get', 'research', 'report'],
    exclude: ['report'], // Exclude report even though it's included
  },
})
class ExcludedActionAgent extends SmrtObject {
  name = '';

  constructor(options: any) {
    super(options);
    // Avoid overwriting getter-only properties
    const { db, ai, fs, ...safeOptions } = options;
    Object.assign(this, safeOptions);
  }

  async research(): Promise<any> {
    return { action: 'research' };
  }

  async report(): Promise<any> {
    return { action: 'report' };
  }
}

// Custom action returning a payload that NESTS a sensitive object (#1540).
@smrt({
  mcp: {
    include: ['wrap'],
  },
})
class MCPNestedResultAgent extends SmrtObject {
  name = '';

  constructor(options: any) {
    super(options);
    const { db, ai, fs, ...safeOptions } = options;
    Object.assign(this, safeOptions);
  }

  async wrap(): Promise<any> {
    // A SmrtObject-like value nested inside a plain object — its toPublicJSON()
    // must be invoked rather than JSON.stringify calling toJSON().
    const sensitiveChild = {
      secret: 'LEAK-VALUE',
      toPublicJSON: () => ({ secret: '[redacted]' }),
    };
    return { wrapped: sensitiveChild, items: [sensitiveChild] };
  }
}

// Custom action whose public METHOD name itself contains an underscore (#1378).
// Tool name becomes `mcpunderscoremethodagent_record_payment`; handleToolCall
// must split on the FIRST underscore so `action` is `record_payment`, not
// `record`.
@smrt({
  mcp: {
    include: ['record_payment'],
  },
})
class MCPUnderscoreMethodAgent extends SmrtObject {
  name = '';

  constructor(options: any) {
    super(options);
    const { db, ai, fs, ...safeOptions } = options;
    Object.assign(this, safeOptions);
  }

  async record_payment(options: any = {}): Promise<any> {
    return {
      action: 'record_payment',
      amount: options.amount ?? 0,
    };
  }
}

@smrt({
  mcp: {
    include: [
      'apply',
      'rebalance',
      'archive',
      'restoreIntoContent',
      'move',
      'fail',
      'opaque',
    ],
  },
  api: { routes: { apply: { scope: 'collection' } } },
})
class MCPConformanceAgent extends SmrtObject {
  async apply(idempotencyKey: string, expectedVersion?: number): Promise<any> {
    return { receiver: 'item', idempotencyKey, expectedVersion };
  }

  static async rebalance(
    idempotencyKey: string,
    expectedVersion?: number,
  ): Promise<any> {
    return { receiver: 'static', idempotencyKey, expectedVersion };
  }

  static async archive(id: string): Promise<any> {
    return { receiver: 'static', actionId: id };
  }

  async restoreIntoContent(idempotencyKey: string): Promise<any> {
    return { receiver: 'camelCase', idempotencyKey };
  }

  async move(id: string): Promise<any> {
    return { receiver: 'item', actionId: id };
  }

  async fail(): Promise<any> {
    return {
      ok: false,
      code: 'conflict',
      message: 'Bearer private-token',
      status: 409,
      details: { authorization: 'private-token', safe: 'still-safe' },
    };
  }

  async opaque(): Promise<any> {
    return { code: 'opaque-success', message: 'leave me untouched' };
  }
}

@smrt({ mcp: { include: ['fanout'] } })
class MCPConformanceCollection extends SmrtCollection<MCPConformanceAgent> {
  static readonly _itemClass = MCPConformanceAgent;

  async fanout(idempotencyKey: string, expectedVersion?: number): Promise<any> {
    return { receiver: 'collection', idempotencyKey, expectedVersion };
  }
}

describe('MCPGenerator with Custom Actions', () => {
  let generator: MCPGenerator;

  beforeEach(() => {
    // Authenticated context so the fail-closed tool-auth gate (#1540) allows
    // mutating custom actions; auth itself is covered by dedicated tests.
    generator = new MCPGenerator({}, { user: { id: 'test-user' } });
    ObjectRegistry.getMethods('MCPConformanceAgent').set('apply', {
      name: 'apply',
      async: true,
      isPublic: true,
      isStatic: false,
      returnType: 'Promise<any>',
      parameters: [
        { name: 'idempotencyKey', type: 'string', optional: false },
        { name: 'expectedVersion', type: 'number', optional: true },
      ],
    });
    ObjectRegistry.getMethods('MCPConformanceAgent').set('rebalance', {
      name: 'rebalance',
      async: true,
      isPublic: true,
      isStatic: true,
      returnType: 'Promise<any>',
      parameters: [
        { name: 'idempotencyKey', type: 'string', optional: false },
        { name: 'expectedVersion', type: 'number', optional: true },
      ],
    });
    ObjectRegistry.getMethods('MCPConformanceAgent').set('archive', {
      name: 'archive',
      async: true,
      isPublic: true,
      isStatic: true,
      returnType: 'Promise<any>',
      parameters: [{ name: 'id', type: 'string', optional: false }],
    });
    ObjectRegistry.getMethods('MCPConformanceAgent').set('restoreIntoContent', {
      name: 'restoreIntoContent',
      async: true,
      isPublic: true,
      isStatic: false,
      returnType: 'Promise<any>',
      parameters: [{ name: 'idempotencyKey', type: 'string', optional: false }],
    });
    ObjectRegistry.getMethods('MCPConformanceAgent').set('move', {
      name: 'move',
      async: true,
      isPublic: true,
      isStatic: false,
      returnType: 'Promise<any>',
      parameters: [{ name: 'id', type: 'string', optional: false }],
    });
    for (const name of ['fail', 'opaque']) {
      ObjectRegistry.getMethods('MCPConformanceAgent').set(name, {
        name,
        async: true,
        isPublic: true,
        isStatic: false,
        returnType: 'Promise<any>',
        parameters: [],
      });
    }
    ObjectRegistry.getMethods('MCPConformanceCollection').set('fanout', {
      name: 'fanout',
      async: true,
      isPublic: true,
      isStatic: false,
      returnType: 'Promise<any>',
      parameters: [
        { name: 'idempotencyKey', type: 'string', optional: false },
        { name: 'expectedVersion', type: 'number', optional: true },
      ],
    });
    ObjectRegistry.invalidateAllInheritanceCaches();
  });

  afterEach(() => {
    // Note: Don't clear registry as classes are only registered once during import
    // ObjectRegistry.clear();
  });

  describe('Tool Generation', () => {
    it('should generate tools for custom actions', async () => {
      const tools = await generator.generateTools();

      // Find tools for our test agent
      const agentTools = tools.filter((tool) =>
        tool.name.startsWith('mcptestagent_'),
      );

      // Should have standard CRUD tools plus custom actions
      const toolNames = agentTools.map((tool) => tool.name);
      expect(toolNames).toContain('mcptestagent_list');
      expect(toolNames).toContain('mcptestagent_get');
      expect(toolNames).toContain('mcptestagent_research');
      expect(toolNames).toContain('mcptestagent_report');
      expect(toolNames).toContain('mcptestagent_analyze');
    });

    it('should have correct schema for custom action tools', async () => {
      const tools = await generator.generateTools();
      const researchTool = tools.find(
        (tool) => tool.name === 'mcptestagent_research',
      );

      expect(researchTool).toBeDefined();
      expect(researchTool?.description).toBe(
        'Execute research action on MCPTestAgent',
      );
      expect(researchTool?.inputSchema.type).toBe('object');
      expect(researchTool?.inputSchema.properties.id).toBeDefined();
      expect(researchTool?.inputSchema.properties.options).toBeDefined();
    });

    it('projects canonical custom-action receivers and typed parameters', async () => {
      const tools = await generator.generateTools();
      const inputSchema = (name: string) =>
        tools.find((tool) => tool.name === name)?.inputSchema;

      expect(inputSchema('mcpconformanceagent_apply')).toMatchObject({
        properties: {
          id: { type: 'string' },
          idempotencyKey: { type: 'string' },
          expectedVersion: { type: 'number' },
        },
        required: ['id', 'idempotencyKey'],
      });
      expect(inputSchema('mcpconformanceagent_rebalance')).toMatchObject({
        properties: {
          idempotencyKey: { type: 'string' },
          expectedVersion: { type: 'number' },
        },
        required: ['idempotencyKey'],
      });
      expect(inputSchema('mcpconformanceagent_archive')).toMatchObject({
        properties: { actionId: { type: 'string' } },
        required: ['actionId'],
      });
      // Tool IDs are lowercased protocol aliases, but the handler resolves the
      // declared camelCase method name before invocation.
      expect(
        inputSchema('mcpconformanceagent_restoreintocontent'),
      ).toMatchObject({
        properties: {
          id: { type: 'string' },
          idempotencyKey: { type: 'string' },
        },
        required: ['id', 'idempotencyKey'],
      });
      expect(inputSchema('mcpconformanceagent_move')).toMatchObject({
        properties: {
          id: { type: 'string' },
          actionId: { type: 'string' },
        },
        required: ['id', 'actionId'],
      });
      // A collection-class method has a real collection receiver, so it is
      // collection-scoped even though it is not static.
      expect(inputSchema('mcpconformancecollection_fanout')).toMatchObject({
        properties: {
          idempotencyKey: { type: 'string' },
          expectedVersion: { type: 'number' },
        },
        required: ['idempotencyKey'],
      });
      // Custom-action discovery never broadens an explicit MCP allowlist into
      // generic mutation tools.
      expect(tools.map((tool) => tool.name)).not.toContain(
        'mcpconformanceagent_create',
      );
    });

    it('should warn about invalid custom actions', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await generator.generateTools();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "Custom action 'nonexistent' specified in MCP config for InvalidActionAgent, but method nonexistent() not found on class",
        ),
      );

      consoleSpy.mockRestore();
    });

    it('should respect exclude configuration for custom actions', async () => {
      const tools = await generator.generateTools();
      const excludedAgentTools = tools.filter((tool) =>
        tool.name.startsWith('excludedactionagent_'),
      );

      const toolNames = excludedAgentTools.map((tool) => tool.name);
      expect(toolNames).toContain('excludedactionagent_research');
      expect(toolNames).not.toContain('excludedactionagent_report'); // Should be excluded
    });
  });

  describe('Custom Action Execution', () => {
    it('strips a sensitive object nested inside a custom-action result (#1540)', async () => {
      const mockObject = new MCPNestedResultAgent({
        db: null,
        ai: null,
        fs: null,
        id: 'nested-id',
      });
      const mockCollection = { get: vi.fn().mockResolvedValue(mockObject) };
      (generator as any).getCollection = vi
        .fn()
        .mockReturnValue(mockCollection);
      (generator as any).collections = new Map([
        ['MCPNestedResultAgent', mockCollection],
      ]);

      const response = await generator.handleToolCall({
        method: 'tools/call',
        params: {
          name: 'mcpnestedresultagent_wrap',
          arguments: { id: 'nested-id' },
        },
      });

      const text = response.content[0].text;
      // Nested object (in a plain object AND in an array) routed through
      // toPublicJSON(), not toJSON() — secret value never serialized.
      expect(text).not.toContain('LEAK-VALUE');
      expect(text).toContain('[redacted]');
    });

    it('should execute custom actions on object instances', async () => {
      // Mock collection and object
      const mockObject = new MCPTestAgent({
        db: null,
        ai: null,
        fs: null,
        id: 'test-id',
        name: 'Test Agent',
        source: 'test-source',
      });

      const mockCollection = {
        get: vi.fn().mockResolvedValue(mockObject),
      };

      // Test the private executeCustomAction method via handleToolCall
      const request = {
        method: 'tools/call',
        params: {
          name: 'mcptestagent_research',
          arguments: {
            id: 'test-id',
            options: { query: 'test query' },
          },
        },
      };

      // Mock the getCollection method to return our mock collection
      const originalGetCollection = (generator as any).getCollection;
      (generator as any).getCollection = vi
        .fn()
        .mockReturnValue(mockCollection);
      (generator as any).collections = new Map([
        ['MCPTestAgent', mockCollection],
      ]);

      const response = await generator.handleToolCall(request);

      expect(response.content[0].type).toBe('text');
      const result = JSON.parse(response.content[0].text);
      expect(result.action).toBe('research');
      expect(result.results).toBe('Research results for: test query');

      // Restore original method
      (generator as any).getCollection = originalGetCollection;
    });

    it('routes a snake_case method tool by splitting on the first underscore (#1378)', async () => {
      const mockObject = new MCPUnderscoreMethodAgent({
        db: null,
        ai: null,
        fs: null,
        id: 'pay-id',
        name: 'Payer',
      });
      const mockCollection = {
        get: vi.fn().mockResolvedValue(mockObject),
      };

      // Tool name is `<objectname>_record_payment`. A naive split('_') would
      // take the action as `record` and fail to find the method; the fix slices
      // at the first underscore so `action` is the full `record_payment`.
      const request = {
        method: 'tools/call',
        params: {
          name: 'mcpunderscoremethodagent_record_payment',
          arguments: {
            id: 'pay-id',
            options: { amount: 42 },
          },
        },
      };

      (generator as any).getCollection = vi
        .fn()
        .mockReturnValue(mockCollection);
      (generator as any).collections = new Map([
        ['MCPUnderscoreMethodAgent', mockCollection],
      ]);

      const response = await generator.handleToolCall(request);

      expect(response.content[0].type).toBe('text');
      const result = JSON.parse(response.content[0].text);
      // Routed to the right method, not "Object type ... not found" or
      // "Method 'record' not found".
      expect(result.action).toBe('record_payment');
      expect(result.amount).toBe(42);
    });

    it('handles recognized collection actions without an ID', async () => {
      // A collection-class method has an actual collection receiver.
      const mockCollection = {
        fanout: vi.fn().mockResolvedValue({
          action: 'fanout',
          level: 'collection',
        }),
      };

      const request = {
        method: 'tools/call',
        params: {
          name: 'mcpconformancecollection_fanout',
          arguments: {
            idempotencyKey: 'collection-query',
          },
        },
      };

      // Mock the getCollection method
      (generator as any).getCollection = vi
        .fn()
        .mockReturnValue(mockCollection);
      (generator as any).collections = new Map([
        ['MCPTestAgent', mockCollection],
      ]);

      const response = await generator.handleToolCall(request);

      expect(response.content[0].type).toBe('text');
      const result = JSON.parse(response.content[0].text);
      expect(result.action).toBe('fanout');
      expect(result.level).toBe('collection');
      expect(mockCollection.fanout).toHaveBeenCalledWith(
        'collection-query',
        undefined,
      );
    });

    it('uses item, static, and collection receivers with positional typed arguments', async () => {
      const item = new MCPConformanceAgent({});
      const collection = {
        get: vi.fn().mockResolvedValue(item),
      };
      (generator as any).getCollection = vi.fn().mockReturnValue(collection);

      const itemResponse = await generator.handleToolCall({
        method: 'tools/call',
        params: {
          name: 'mcpconformanceagent_apply',
          arguments: {
            id: 'item-1',
            idempotencyKey: 'retry-item',
            expectedVersion: 3,
          },
        },
      });
      expect(JSON.parse(itemResponse.content[0].text)).toMatchObject({
        receiver: 'item',
        idempotencyKey: 'retry-item',
        expectedVersion: 3,
      });

      const camelCaseResponse = await generator.handleToolCall({
        method: 'tools/call',
        params: {
          name: 'mcpconformanceagent_restoreintocontent',
          arguments: { id: 'item-1', idempotencyKey: 'camel-case' },
        },
      });
      expect(JSON.parse(camelCaseResponse.content[0].text)).toMatchObject({
        receiver: 'camelCase',
        idempotencyKey: 'camel-case',
      });

      const moveResponse = await generator.handleToolCall({
        method: 'tools/call',
        params: {
          name: 'mcpconformanceagent_move',
          arguments: { id: 'item-1', actionId: 'destination-2' },
        },
      });
      expect(JSON.parse(moveResponse.content[0].text)).toMatchObject({
        receiver: 'item',
        actionId: 'destination-2',
      });

      const staticResponse = await generator.handleToolCall({
        method: 'tools/call',
        params: {
          name: 'mcpconformanceagent_rebalance',
          arguments: { idempotencyKey: 'retry-static', expectedVersion: 4 },
        },
      });
      expect(JSON.parse(staticResponse.content[0].text)).toMatchObject({
        receiver: 'static',
        idempotencyKey: 'retry-static',
        expectedVersion: 4,
      });

      const archiveResponse = await generator.handleToolCall({
        method: 'tools/call',
        params: {
          name: 'mcpconformanceagent_archive',
          arguments: { actionId: 'archive-2' },
        },
      });
      expect(JSON.parse(archiveResponse.content[0].text)).toMatchObject({
        receiver: 'static',
        actionId: 'archive-2',
      });

      const collectionReceiver = {
        fanout: vi.fn(function (
          idempotencyKey: string,
          expectedVersion?: number,
        ) {
          return {
            receiver: this === collectionReceiver ? 'collection' : 'wrong',
            idempotencyKey,
            expectedVersion,
          };
        }),
      };
      (generator as any).getCollection = vi
        .fn()
        .mockReturnValue(collectionReceiver);
      const collectionResponse = await generator.handleToolCall({
        method: 'tools/call',
        params: {
          name: 'mcpconformancecollection_fanout',
          arguments: { idempotencyKey: 'retry-collection', expectedVersion: 5 },
        },
      });
      expect(JSON.parse(collectionResponse.content[0].text)).toMatchObject({
        receiver: 'collection',
        idempotencyKey: 'retry-collection',
        expectedVersion: 5,
      });
      expect(collectionReceiver.fanout).toHaveBeenCalledWith(
        'retry-collection',
        5,
      );
    });

    it('returns redacted conventional failures as MCP errors without changing opaque successes', async () => {
      const object = new MCPConformanceAgent({});
      (generator as any).getCollection = vi
        .fn()
        .mockReturnValue({ get: vi.fn().mockResolvedValue(object) });

      const failure = await generator.handleToolCall({
        method: 'tools/call',
        params: {
          name: 'mcpconformanceagent_fail',
          arguments: { id: 'item-1' },
        },
      });
      expect(failure.isError).toBe(true);
      expect(failure._meta).toMatchObject({
        'io.happyvertical/smrt': {
          code: 'conflict',
          status: 409,
          message: 'Bearer [REDACTED]',
          details: { authorization: '[REDACTED]', safe: 'still-safe' },
        },
      });
      expect(failure.content[0].text).not.toContain('private-token');

      const opaque = await generator.handleToolCall({
        method: 'tools/call',
        params: {
          name: 'mcpconformanceagent_opaque',
          arguments: { id: 'item-1' },
        },
      });
      expect(opaque.isError).toBeUndefined();
      expect(JSON.parse(opaque.content[0].text)).toEqual({
        code: 'opaque-success',
        message: 'leave me untouched',
      });
    });

    it('emits the same custom-action receiver, positional arguments, and error contract for modular MCP servers', async () => {
      const outputDir = await mkdtemp(join(tmpdir(), 'smrt-modular-mcp-'));
      try {
        await generator.generateServer({
          outputPath: join(outputDir, 'index.js'),
          modular: true,
        });
        const handlers = await readFile(
          join(outputDir, 'handlers', 'index.js'),
          'utf-8',
        );

        expect(handlers).toMatch(/case ["']mcpconformanceagent_apply["']/);
        expect(handlers).toMatch(/case ["']mcpconformanceagent_rebalance["']/);
        expect(handlers).toMatch(/case ["']mcpconformanceagent_archive["']/);
        expect(handlers).toMatch(
          /case ["']mcpconformanceagent_restoreintocontent["']/,
        );
        expect(handlers).toMatch(/case ["']mcpconformanceagent_move["']/);
        expect(handlers).toMatch(
          /case ["']mcpconformancecollection_fanout["']/,
        );
        expect(handlers).toContain(
          'Custom action rebalance is collection-scoped and does not accept an ID',
        );
        expect(handlers).toContain(
          'ObjectRegistry.getClass("MCPConformanceAgent")?.constructor',
        );
        expect(handlers).toContain('args["idempotencyKey"]');
        expect(handlers).toContain('args["actionId"]');
        expect(handlers).toContain('target["restoreIntoContent"]');
        expect(handlers).toContain('actionMethod.call(target, ...methodArgs)');
        expect(handlers).toContain('normalizeCustomActionFailure(result)');
        expect(handlers).toContain(
          '[SMRT_CUSTOM_ACTION_ERROR_METADATA_KEY]: failure',
        );
        expect(handlers).toContain('const STI_TARGETS');
        expect(handlers).toContain('resolveCreateTarget');
        expect(handlers).toMatch(
          /process\.env\.DATABASE_TYPE \|\| ["']sqlite["']/,
        );
      } finally {
        await rm(outputDir, { recursive: true, force: true });
      }
    });

    it('should handle errors in custom action execution', async () => {
      const mockObject = new MCPTestAgent({
        db: null,
        ai: null,
        fs: null,
        id: 'test-id',
        name: 'Test Agent',
      });

      // Override the research method to throw an error
      mockObject.research = vi
        .fn()
        .mockRejectedValue(new Error('Research failed'));

      const mockCollection = {
        get: vi.fn().mockResolvedValue(mockObject),
      };

      const request = {
        method: 'tools/call',
        params: {
          name: 'mcptestagent_research',
          arguments: {
            id: 'test-id',
          },
        },
      };

      (generator as any).getCollection = vi
        .fn()
        .mockReturnValue(mockCollection);
      (generator as any).collections = new Map([
        ['MCPTestAgent', mockCollection],
      ]);

      const response = await generator.handleToolCall(request);

      expect(response.content[0].type).toBe('text');
      expect(response.content[0].text).toContain(
        'Failed to execute custom action',
      );
      expect(response.content[0].text).toContain('Research failed');
    });
  });
});
