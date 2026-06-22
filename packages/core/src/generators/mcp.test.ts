/**
 * Tests for MCP generator with custom action support
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('MCPGenerator with Custom Actions', () => {
  let generator: MCPGenerator;

  beforeEach(() => {
    // Authenticated context so the fail-closed tool-auth gate (#1540) allows
    // mutating custom actions; auth itself is covered by dedicated tests.
    generator = new MCPGenerator({}, { user: { id: 'test-user' } });
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

    it('should handle custom actions without ID (collection-level)', async () => {
      // Mock collection with custom method
      const mockCollection = {
        research: vi
          .fn()
          .mockResolvedValue({ action: 'research', level: 'collection' }),
      };

      const request = {
        method: 'tools/call',
        params: {
          name: 'mcptestagent_research',
          arguments: {
            options: { query: 'collection query' },
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
      expect(result.action).toBe('research');
      expect(result.level).toBe('collection');
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
